/*
OBS Stream Manager Output
Copyright (C) 2026 OBS Stream Manager contributors

This program is free software; you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation; either version 2 of the License, or
(at your option) any later version.
*/

#include <obs-frontend-api.h>
#include <obs-module.h>
#include <string.h>
#include <util/config-file.h>
#include <util/dstr.h>
#include <util/platform.h>
#include <util/threading.h>

#ifdef _WIN32
#include <windows.h>
#endif

#include "obs-websocket-api.h"

OBS_DECLARE_MODULE()
OBS_MODULE_AUTHOR("OBS Stream Manager contributors")

#define OBS_STREAM_MANAGER_OUTPUT_API_VERSION 4
#define STREAM_MIXER_INDEX 5
#define TWITCH_GRACEFUL_STOP_POLL_MS 50
#define TWITCH_GRACEFUL_STOP_TIMEOUT_MS 2000

static obs_websocket_vendor vendor;
static obs_output_t *twitch_output;
static obs_service_t *twitch_service;
static obs_encoder_t *twitch_video_encoder;
static obs_encoder_t *twitch_audio_encoder;
static bool twitch_audio_encoder_shared;
static pthread_mutex_t managed_stream_mutex;
static pthread_mutex_t twitch_output_mutex;
static bool managed_stream_configuration_applied;
static bool managed_stream_activation_race_blocked;
static long long managed_primary_video_bitrate_kbps;
static long long managed_twitch_video_bitrate_kbps;
static long long managed_audio_bitrate_kbps;

#ifdef _WIN32
static void launch_companion_app(void)
{
	wchar_t executable[MAX_PATH];
	DWORD value_type = 0;
	DWORD value_size = sizeof(executable);
	const LSTATUS status = RegGetValueW(HKEY_CURRENT_USER, L"Software\\OBS Stream Manager", L"ExecutablePath",
					    RRF_RT_REG_SZ, &value_type, executable, &value_size);
	if (status != ERROR_SUCCESS || value_type != REG_SZ || value_size < sizeof(wchar_t))
		return;

	executable[(sizeof(executable) / sizeof(executable[0])) - 1] = L'\0';
	const DWORD attributes = GetFileAttributesW(executable);
	if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_DIRECTORY)) {
		blog(LOG_WARNING, "[OBS Stream Manager Output] Registered companion application is unavailable");
		return;
	}

	wchar_t command_line[(MAX_PATH * 2) + 32];
	const int length = swprintf_s(command_line, sizeof(command_line) / sizeof(command_line[0]), L"\"%ls\" --background",
				      executable);
	if (length <= 0)
		return;

	STARTUPINFOW startup = {0};
	PROCESS_INFORMATION process = {0};
	startup.cb = sizeof(startup);
	if (!CreateProcessW(executable, command_line, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &startup, &process)) {
		blog(LOG_WARNING, "[OBS Stream Manager Output] Companion application launch failed: %lu", GetLastError());
		return;
	}

	CloseHandle(process.hThread);
	CloseHandle(process.hProcess);
	blog(LOG_INFO, "[OBS Stream Manager Output] Companion application launch requested");
}
#endif

MODULE_EXPORT const char *obs_module_description(void)
{
	return "In-memory secondary Twitch output for OBS Stream Manager";
}

static void set_error(obs_data_t *response, const char *message)
{
	obs_data_set_bool(response, "success", false);
	obs_data_set_string(response, "error", message && *message ? message : "Twitch output operation failed");
}

static bool stop_twitch_output_gracefully(void)
{
	if (!twitch_output || !obs_output_active(twitch_output))
		return true;

	obs_output_stop(twitch_output);
	for (unsigned int waited_ms = 0;
	     obs_output_active(twitch_output) && waited_ms < TWITCH_GRACEFUL_STOP_TIMEOUT_MS;
	     waited_ms += TWITCH_GRACEFUL_STOP_POLL_MS)
		os_sleep_ms(TWITCH_GRACEFUL_STOP_POLL_MS);

	if (!obs_output_active(twitch_output))
		return true;

	blog(LOG_WARNING, "[OBS Stream Manager Output] Graceful Twitch stop timed out; forcing output stop");
	obs_output_force_stop(twitch_output);
	return false;
}

static void release_twitch_output(void)
{
	if (twitch_output) {
		if (obs_output_active(twitch_output))
			obs_output_force_stop(twitch_output);
		obs_output_release(twitch_output);
		twitch_output = NULL;
	}
	if (twitch_video_encoder) {
		obs_encoder_release(twitch_video_encoder);
		twitch_video_encoder = NULL;
	}
	if (twitch_audio_encoder) {
		obs_encoder_release(twitch_audio_encoder);
		twitch_audio_encoder = NULL;
	}
	twitch_audio_encoder_shared = false;
	if (twitch_service) {
		obs_service_release(twitch_service);
		twitch_service = NULL;
	}
}

static void start_twitch(obs_data_t *request, obs_data_t *response, void *private_data)
{
	UNUSED_PARAMETER(private_data);
	pthread_mutex_lock(&twitch_output_mutex);
	const char *server = obs_data_get_string(request, "server");
	const char *key = obs_data_get_string(request, "key");
	if (!server || !*server || !key || !*key) {
		set_error(response, "Twitch server or stream key is missing");
		pthread_mutex_unlock(&twitch_output_mutex);
		return;
	}

	obs_output_t *main_output = obs_frontend_get_streaming_output();
	if (!main_output || !obs_output_active(main_output)) {
		if (main_output)
			obs_output_release(main_output);
		set_error(response, "The primary OBS stream must be active before Twitch starts");
		pthread_mutex_unlock(&twitch_output_mutex);
		return;
	}

	obs_encoder_t *main_video_encoder = obs_output_get_video_encoder(main_output);
	obs_encoder_t *main_audio_encoder = obs_output_get_audio_encoder(main_output, 0);
	if (!main_video_encoder || !main_audio_encoder) {
		obs_output_release(main_output);
		set_error(response, "The primary OBS stream encoders are unavailable");
		pthread_mutex_unlock(&twitch_output_mutex);
		return;
	}

	obs_data_t *main_video_settings = obs_encoder_get_settings(main_video_encoder);
	obs_data_t *video_settings = obs_data_create();
	obs_data_apply(video_settings, main_video_settings);
	obs_data_release(main_video_settings);
	const char *video_encoder_id = obs_encoder_get_id(main_video_encoder);
	const size_t audio_mixer_index = obs_encoder_get_mixer_index(main_audio_encoder);
	if (audio_mixer_index != STREAM_MIXER_INDEX) {
		obs_data_release(video_settings);
		obs_output_release(main_output);
		set_error(response, "The primary stream audio encoder must use STREAM MIX track 6");
		pthread_mutex_unlock(&twitch_output_mutex);
		return;
	}
	/* The primary encoder is already active, so make the Twitch settings explicit
	 * before creating its dedicated encoder. Updating rate control/keyframes after
	 * an encoder starts is ignored by several NVENC/x264 implementations. */
	pthread_mutex_lock(&managed_stream_mutex);
	const long long video_bitrate_kbps = managed_twitch_video_bitrate_kbps;
	const long long audio_bitrate_kbps = managed_audio_bitrate_kbps;
	pthread_mutex_unlock(&managed_stream_mutex);
	if (video_bitrate_kbps < 500 || video_bitrate_kbps > 6000 || audio_bitrate_kbps < 64 ||
	    audio_bitrate_kbps > 160) {
		obs_data_release(video_settings);
		obs_output_release(main_output);
		set_error(response, "Managed stream bitrates are unavailable; configure the primary stream first");
		pthread_mutex_unlock(&twitch_output_mutex);
		return;
	}
	obs_data_set_string(video_settings, "rate_control", "CBR");
	obs_data_set_int(video_settings, "keyint_sec", 2);
	obs_data_set_int(video_settings, "bf", 2);
	/* NVENC look-ahead consumes additional GPU scheduling headroom and was
	 * enabled in the real 1080p60 recording that reported encoding lag. Keep
	 * psycho-visual tuning inherited, but disable look-ahead for both public
	 * outputs so recording can reuse the primary encoder without extra stalls. */
	obs_data_set_bool(video_settings, "lookahead", false);
	obs_data_set_int(video_settings, "bitrate", video_bitrate_kbps);

	stop_twitch_output_gracefully();
	release_twitch_output();
	twitch_video_encoder = obs_video_encoder_create(video_encoder_id, "obs_stream_manager_twitch_video_encoder",
							 video_settings, NULL);
	/*
	 * Share the already-active primary AAC encoder instead of starting a
	 * second FFmpeg AAC encoder on the same mixer. The latter can report an
	 * active RTMP output while sending silent AAC frames on Windows. Sharing
	 * the primary track-6 encoder is the same proven model used by established
	 * multi-output plugins and guarantees both destinations receive the exact
	 * STREAM MIX packets that OBS is already sending.
	 */
	twitch_audio_encoder = obs_encoder_get_ref(main_audio_encoder);
	twitch_audio_encoder_shared = twitch_audio_encoder != NULL;
	obs_data_release(video_settings);
	if (!twitch_video_encoder || !twitch_audio_encoder) {
		obs_output_release(main_output);
		set_error(response, "Unable to create dedicated Twitch encoders");
		release_twitch_output();
		pthread_mutex_unlock(&twitch_output_mutex);
		return;
	}
	obs_encoder_set_video(twitch_video_encoder, obs_encoder_video(main_video_encoder));
	obs_encoder_set_audio(twitch_audio_encoder, obs_encoder_audio(main_audio_encoder));
	obs_encoder_set_frame_rate_divisor(twitch_video_encoder, 1);
	if (obs_encoder_scaling_enabled(main_video_encoder))
		obs_encoder_set_scaled_size(twitch_video_encoder, obs_encoder_get_width(main_video_encoder),
					    obs_encoder_get_height(main_video_encoder));

	obs_data_t *service_settings = obs_data_create();
	obs_data_set_string(service_settings, "server", server);
	obs_data_set_string(service_settings, "key", key);
	obs_data_set_bool(service_settings, "use_auth", false);
	twitch_service = obs_service_create("rtmp_custom", "obs_stream_manager_twitch_service", service_settings, NULL);
	obs_data_release(service_settings);
	if (!twitch_service) {
		obs_output_release(main_output);
		release_twitch_output();
		set_error(response, "Unable to create the Twitch RTMP service");
		pthread_mutex_unlock(&twitch_output_mutex);
		return;
	}

	const char *output_type = obs_service_get_preferred_output_type(twitch_service);
	if (!output_type)
		output_type = "rtmp_output";
	twitch_output = obs_output_create(output_type, "obs_stream_manager_twitch_output", NULL, NULL);
	if (!twitch_output) {
		obs_output_release(main_output);
		release_twitch_output();
		set_error(response, "Unable to create the Twitch output");
		pthread_mutex_unlock(&twitch_output_mutex);
		return;
	}

	obs_output_set_service(twitch_output, twitch_service);
	obs_output_set_video_encoder(twitch_output, twitch_video_encoder);
	obs_output_set_audio_encoder(twitch_output, twitch_audio_encoder, 0);
	obs_output_release(main_output);

	if (!obs_output_start(twitch_output)) {
		const char *last_error = obs_output_get_last_error(twitch_output);
		set_error(response, last_error && *last_error ? last_error : "OBS rejected the Twitch output start request");
		release_twitch_output();
		pthread_mutex_unlock(&twitch_output_mutex);
		return;
	}

	obs_data_set_bool(response, "success", true);
	obs_data_set_bool(response, "outputActive", true);
	blog(LOG_INFO, "[OBS Stream Manager Output] Twitch output started");
	pthread_mutex_unlock(&twitch_output_mutex);
}

static void stop_twitch(obs_data_t *request, obs_data_t *response, void *private_data)
{
	UNUSED_PARAMETER(request);
	UNUSED_PARAMETER(private_data);
	pthread_mutex_lock(&twitch_output_mutex);
	const bool graceful = stop_twitch_output_gracefully();
	release_twitch_output();
	obs_data_set_bool(response, "success", true);
	obs_data_set_bool(response, "outputActive", false);
	obs_data_set_bool(response, "gracefulStop", graceful);
	blog(LOG_INFO, "[OBS Stream Manager Output] Twitch output stopped");
	pthread_mutex_unlock(&twitch_output_mutex);
}

static void twitch_status(obs_data_t *request, obs_data_t *response, void *private_data)
{
	UNUSED_PARAMETER(request);
	UNUSED_PARAMETER(private_data);
	pthread_mutex_lock(&twitch_output_mutex);
	const bool active = twitch_output && obs_output_active(twitch_output);
	obs_data_set_bool(response, "success", true);
	obs_data_set_string(response, "pluginVersion", OBS_STREAM_MANAGER_OUTPUT_VERSION);
	obs_data_set_int(response, "apiVersion", OBS_STREAM_MANAGER_OUTPUT_API_VERSION);
	obs_data_set_bool(response, "outputActive", active);
	obs_data_set_int(response, "bytesSent", twitch_output ? (long long)obs_output_get_total_bytes(twitch_output) : 0);
	obs_data_set_int(response, "totalFrames", twitch_output ? (long long)obs_output_get_total_frames(twitch_output) : 0);
	obs_data_set_int(response, "skippedFrames", twitch_output ? (long long)obs_output_get_frames_dropped(twitch_output) : 0);
	obs_data_set_bool(response, "dedicatedEncoder", twitch_video_encoder && twitch_audio_encoder);
	obs_data_set_bool(response, "dedicatedVideoEncoder", twitch_video_encoder != NULL);
	obs_data_set_bool(response, "sharedPrimaryAudioEncoder", twitch_audio_encoder_shared);
	obs_data_set_int(response, "audioMixerIndex",
			 twitch_audio_encoder ? (long long)obs_encoder_get_mixer_index(twitch_audio_encoder) : -1);
	pthread_mutex_lock(&managed_stream_mutex);
	obs_data_set_int(response, "primaryVideoBitrateKbps", managed_primary_video_bitrate_kbps);
	obs_data_set_int(response, "twitchVideoBitrateKbps", managed_twitch_video_bitrate_kbps);
	obs_data_set_int(response, "audioBitrateKbps", managed_audio_bitrate_kbps);
	pthread_mutex_unlock(&managed_stream_mutex);
	if (twitch_video_encoder) {
		const uint32_t divisor = obs_encoder_get_frame_rate_divisor(twitch_video_encoder);
		const struct video_output_info *video_info = video_output_get_info(obs_encoder_video(twitch_video_encoder));
		obs_data_set_int(response, "videoWidth", obs_encoder_get_width(twitch_video_encoder));
		obs_data_set_int(response, "videoHeight", obs_encoder_get_height(twitch_video_encoder));
		if (video_info) {
			obs_data_set_int(response, "fpsNumerator", video_info->fps_num);
			obs_data_set_int(response, "fpsDenominator", video_info->fps_den * (divisor ? divisor : 1));
		}
	}
	pthread_mutex_unlock(&twitch_output_mutex);
}

static void set_source_force_mono(obs_data_t *request, obs_data_t *response, void *private_data)
{
	UNUSED_PARAMETER(private_data);
	const char *source_name = obs_data_get_string(request, "sourceName");
	if (!source_name || !*source_name) {
		set_error(response, "The audio source name is missing");
		return;
	}

	obs_source_t *source = obs_get_source_by_name(source_name);
	if (!source) {
		set_error(response, "The requested audio source was not found");
		return;
	}
	if (!(obs_source_get_output_flags(source) & OBS_SOURCE_AUDIO)) {
		obs_source_release(source);
		set_error(response, "The requested source does not provide audio");
		return;
	}

	const bool enabled = !obs_data_has_user_value(request, "enabled") || obs_data_get_bool(request, "enabled");
	const uint32_t previous_flags = obs_source_get_flags(source);
	const bool previous_enabled = (previous_flags & OBS_SOURCE_FLAG_FORCE_MONO) != 0;
	const uint32_t next_flags = enabled ? previous_flags | OBS_SOURCE_FLAG_FORCE_MONO
					    : previous_flags & ~OBS_SOURCE_FLAG_FORCE_MONO;
	if (next_flags != previous_flags)
		obs_source_set_flags(source, next_flags);
	obs_source_release(source);

	obs_data_set_bool(response, "success", true);
	obs_data_set_bool(response, "enabled", enabled);
	obs_data_set_bool(response, "previousEnabled", previous_enabled);
	obs_data_set_bool(response, "changed", next_flags != previous_flags);
	blog(LOG_INFO, "[OBS Stream Manager Output] Force mono %s for source '%s'", enabled ? "enabled" : "disabled",
	     source_name);
}

bool obs_module_load(void)
{
	if (pthread_mutex_init(&managed_stream_mutex, NULL) != 0) {
		blog(LOG_ERROR, "[OBS Stream Manager Output] Managed stream mutex initialization failed");
		return false;
	}
	if (pthread_mutex_init(&twitch_output_mutex, NULL) != 0) {
		blog(LOG_ERROR, "[OBS Stream Manager Output] Twitch output mutex initialization failed");
		pthread_mutex_destroy(&managed_stream_mutex);
		return false;
	}
	#ifdef _WIN32
	launch_companion_app();
	#endif
	blog(LOG_INFO, "[OBS Stream Manager Output] Plugin loaded");
	return true;
}

static void apply_managed_video_settings(obs_data_t *settings, long long video_bitrate_kbps)
{
	obs_data_set_string(settings, "rate_control", "CBR");
	obs_data_set_int(settings, "bitrate", video_bitrate_kbps);
	obs_data_set_int(settings, "keyint_sec", 2);
	obs_data_set_int(settings, "bf", 2);
	obs_data_set_bool(settings, "lookahead", false);
}

static bool video_settings_match(obs_encoder_t *encoder, long long video_bitrate_kbps)
{
	if (!encoder)
		return false;
	obs_data_t *settings = obs_encoder_get_settings(encoder);
	const char *rate_control = obs_data_get_string(settings, "rate_control");
	const bool matches = rate_control && strcmp(rate_control, "CBR") == 0 &&
			     obs_data_get_int(settings, "bitrate") == video_bitrate_kbps &&
			     obs_data_get_int(settings, "keyint_sec") == 2 && obs_data_get_int(settings, "bf") == 2 &&
			     !obs_data_get_bool(settings, "lookahead");
	obs_data_release(settings);
	return matches;
}

static bool audio_settings_match(obs_encoder_t *encoder, long long audio_bitrate_kbps)
{
	if (!encoder)
		return true;
	obs_data_t *settings = obs_encoder_get_settings(encoder);
	const bool matches = obs_data_get_int(settings, "bitrate") == audio_bitrate_kbps;
	obs_data_release(settings);
	return matches;
}

static bool persist_stream_encoder_settings(long long video_bitrate_kbps)
{
	char *profile_path = obs_frontend_get_current_profile_path();
	if (!profile_path)
		return false;

	struct dstr filename = {0};
	dstr_printf(&filename, "%s/streamEncoder.json", profile_path);
	bfree(profile_path);
	obs_data_t *settings = obs_data_create_from_json_file_safe(filename.array, "bak");
	if (!settings && os_file_exists(filename.array)) {
		dstr_free(&filename);
		return false;
	}
	if (!settings)
		settings = obs_data_create();
	apply_managed_video_settings(settings, video_bitrate_kbps);
	const bool saved = obs_data_save_json_pretty_safe(settings, filename.array, "tmp", "bak");
	obs_data_release(settings);
	dstr_free(&filename);
	return saved;
}

static bool persist_audio_encoder_settings(long long audio_bitrate_kbps)
{
	config_t *profile = obs_frontend_get_profile_config();
	if (!profile)
		return false;
	for (size_t index = 1; index <= 6; index++) {
		char name[24];
		snprintf(name, sizeof(name), "Track%zuBitrate", index);
		config_set_uint(profile, "AdvOut", name, (uint64_t)audio_bitrate_kbps);
	}
	return config_save(profile) == CONFIG_SUCCESS;
}

static void apply_managed_recording_settings(obs_data_t *settings, long long video_bitrate_kbps,
                                            long long max_video_bitrate_kbps)
{
	obs_data_set_string(settings, "rate_control", "VBR");
	obs_data_unset_user_value(settings, "cqp");
	obs_data_set_int(settings, "bitrate", video_bitrate_kbps);
	obs_data_set_int(settings, "max_bitrate", max_video_bitrate_kbps);
	obs_data_set_int(settings, "keyint_sec", 2);
	obs_data_set_int(settings, "bf", 2);
	obs_data_set_string(settings, "preset", "p5");
	obs_data_set_string(settings, "tune", "hq");
	obs_data_set_string(settings, "multipass", "disabled");
	obs_data_set_string(settings, "profile", "high");
	obs_data_set_bool(settings, "lookahead", false);
	/* OBS 31 renamed Psycho Visual Tuning to Adaptive Quantization.
	 * Persist both names so the fixed recording preset remains off when an
	 * older compatible encoder implementation is loaded. */
	obs_data_set_bool(settings, "adaptive_quantization", false);
	obs_data_set_bool(settings, "psycho_aq", false);
}

static bool recording_settings_match(obs_encoder_t *encoder, long long video_bitrate_kbps,
                                     long long max_video_bitrate_kbps)
{
	if (!encoder)
		return false;
	obs_data_t *settings = obs_encoder_get_settings(encoder);
	const char *rate_control = obs_data_get_string(settings, "rate_control");
	const char *preset = obs_data_get_string(settings, "preset");
	const char *tune = obs_data_get_string(settings, "tune");
	const char *multipass = obs_data_get_string(settings, "multipass");
	const bool matches = rate_control && strcmp(rate_control, "VBR") == 0 &&
			     obs_data_get_int(settings, "bitrate") == video_bitrate_kbps &&
			     obs_data_get_int(settings, "max_bitrate") == max_video_bitrate_kbps &&
			     preset && strcmp(preset, "p5") == 0 && tune && strcmp(tune, "hq") == 0 &&
			     multipass && strcmp(multipass, "disabled") == 0 &&
			     !obs_data_get_bool(settings, "lookahead") &&
			     !obs_data_get_bool(settings, "adaptive_quantization") &&
			     !obs_data_get_bool(settings, "psycho_aq");
	obs_data_release(settings);
	return matches;
}

static bool persist_recording_encoder_settings(long long video_bitrate_kbps, long long max_video_bitrate_kbps,
                                               long long audio_bitrate_kbps)
{
	char *profile_path = obs_frontend_get_current_profile_path();
	if (!profile_path)
		return false;

	struct dstr filename = {0};
	dstr_printf(&filename, "%s/recordEncoder.json", profile_path);
	bfree(profile_path);
	obs_data_t *settings = obs_data_create_from_json_file_safe(filename.array, "bak");
	if (!settings && os_file_exists(filename.array)) {
		dstr_free(&filename);
		return false;
	}
	if (!settings)
		settings = obs_data_create();
	apply_managed_recording_settings(settings, video_bitrate_kbps, max_video_bitrate_kbps);
	const bool encoder_saved = obs_data_save_json_pretty_safe(settings, filename.array, "tmp", "bak");
	obs_data_release(settings);
	dstr_free(&filename);
	if (!encoder_saved)
		return false;

	config_t *profile = obs_frontend_get_profile_config();
	if (!profile)
		return false;
	config_set_string(profile, "Output", "Mode", "Advanced");
	config_set_bool(profile, "General", "AutoRemux", true);
	config_set_string(profile, "AdvOut", "RecType", "Standard");
	config_set_string(profile, "AdvOut", "RecFormat2", "mkv");
	config_set_bool(profile, "AdvOut", "RecUseRescale", false);
	config_set_string(profile, "AdvOut", "RecEncoder", "obs_nvenc_h264_tex");
	config_set_uint(profile, "AdvOut", "RecTracks", 63);
	config_set_uint(profile, "Audio", "SampleRate", 48000);
	for (size_t index = 1; index <= 6; index++) {
		char name[24];
		snprintf(name, sizeof(name), "Track%zuBitrate", index);
		config_set_uint(profile, "AdvOut", name, (uint64_t)audio_bitrate_kbps);
	}
	return config_save(profile) == CONFIG_SUCCESS;
}

struct configure_recording_task {
	long long video_bitrate_kbps;
	long long max_video_bitrate_kbps;
	long long audio_bitrate_kbps;
	bool outputs_active;
	bool profile_persisted;
	bool advanced_mode_configured;
	bool encoder_available;
	bool encoder_active;
	bool settings_current;
	bool encoder_updated;
};

static void configure_recording_on_ui(void *param)
{
	struct configure_recording_task *task = param;
	/* Do not even persist changes while an output is active. */
	task->outputs_active = obs_frontend_streaming_active() || obs_frontend_recording_active() ||
			       obs_frontend_replay_buffer_active();
	if (task->outputs_active)
		return;
	config_t *profile = obs_frontend_get_profile_config();
	const char *mode = profile ? config_get_string(profile, "Output", "Mode") : NULL;
	task->advanced_mode_configured = mode && strcmp(mode, "Advanced") == 0;
	task->profile_persisted = persist_recording_encoder_settings(task->video_bitrate_kbps,
								   task->max_video_bitrate_kbps, task->audio_bitrate_kbps);
	if (!task->profile_persisted)
		return;

	obs_encoder_t *video_encoder = obs_get_encoder_by_name("advanced_video_recording");
	task->encoder_available = video_encoder != NULL;
	task->encoder_active = video_encoder && obs_encoder_active(video_encoder);
	if (task->encoder_active) {
		task->settings_current = recording_settings_match(video_encoder, task->video_bitrate_kbps,
								 task->max_video_bitrate_kbps);
	} else if (video_encoder) {
		obs_data_t *settings = obs_encoder_get_settings(video_encoder);
		apply_managed_recording_settings(settings, task->video_bitrate_kbps, task->max_video_bitrate_kbps);
		obs_encoder_update(video_encoder, settings);
		obs_data_release(settings);
		if (!obs_encoder_active(video_encoder)) {
			task->encoder_updated = true;
			task->settings_current = recording_settings_match(video_encoder, task->video_bitrate_kbps,
									 task->max_video_bitrate_kbps);
		} else {
			task->encoder_active = true;
			task->settings_current = false;
		}
	}
	if (video_encoder)
		obs_encoder_release(video_encoder);
}

static void configure_recording(obs_data_t *request, obs_data_t *response, void *private_data)
{
	UNUSED_PARAMETER(private_data);
	const char *rate_control = obs_data_get_string(request, "rateControl");
	const long long video_bitrate_kbps = obs_data_get_int(request, "videoBitrateKbps");
	const long long max_video_bitrate_kbps = obs_data_get_int(request, "maxVideoBitrateKbps");
	const long long audio_bitrate_kbps = obs_data_get_int(request, "audioBitrateKbps");
	if (!rate_control || strcmp(rate_control, "VBR") != 0 || video_bitrate_kbps < 1000 ||
	    max_video_bitrate_kbps < video_bitrate_kbps || max_video_bitrate_kbps > 10000 ||
	    audio_bitrate_kbps < 64 || audio_bitrate_kbps > 320) {
		set_error(response, "Managed recording requires bounded VBR up to 10000 Kbps; update OBS Stream Manager");
		return;
	}

	struct configure_recording_task task = {
		.video_bitrate_kbps = video_bitrate_kbps,
		.max_video_bitrate_kbps = max_video_bitrate_kbps,
		.audio_bitrate_kbps = audio_bitrate_kbps,
	};
	if (obs_in_task_thread(OBS_TASK_UI))
		configure_recording_on_ui(&task);
	else
		obs_queue_task(OBS_TASK_UI, configure_recording_on_ui, &task, true);
	if (task.outputs_active) {
		set_error(response, "Stop active outputs before changing recording settings");
		obs_data_set_bool(response, "blockedByActiveEncoder", true);
		return;
	}
	if (!task.profile_persisted) {
		set_error(response, "The current OBS recording profile could not be updated safely");
		return;
	}
	if (!task.advanced_mode_configured) {
		set_error(response, "OBS output mode must be Advanced before managed recording settings can be applied");
		obs_data_set_bool(response, "profilePersisted", true);
		return;
	}
	if (!task.encoder_available) {
		set_error(response, "The Advanced recording encoder has not loaded; reload the dedicated profile and retry");
		obs_data_set_bool(response, "profilePersisted", true);
		obs_data_set_bool(response, "restartRequired", true);
		return;
	}
	if (task.encoder_active || !task.settings_current) {
		set_error(response, "The recording encoder could not accept the fixed settings while inactive");
		obs_data_set_bool(response, "blockedByActiveEncoder", task.encoder_active);
		obs_data_set_bool(response, "profilePersisted", true);
		return;
	}

	obs_data_set_bool(response, "success", true);
	obs_data_set_bool(response, "advancedHandlerReady", true);
	obs_data_set_bool(response, "encoderUpdated", task.encoder_updated);
	obs_data_set_bool(response, "profilePersisted", true);
	obs_data_set_string(response, "rateControl", "VBR");
	obs_data_set_int(response, "videoBitrateKbps", video_bitrate_kbps);
	obs_data_set_int(response, "maxVideoBitrateKbps", max_video_bitrate_kbps);
	obs_data_set_int(response, "audioBitrateKbps", audio_bitrate_kbps);
	blog(LOG_INFO, "[OBS Stream Manager Output] Recording-only encoder configured: H264 VBR=%lld, max=%lld, audio=%lld Kbps",
	     video_bitrate_kbps, max_video_bitrate_kbps, audio_bitrate_kbps);
}

struct configure_stream_task {
	long long video_bitrate_kbps;
	long long audio_bitrate_kbps;
	bool profile_persisted;
	bool advanced_mode_configured;
	bool encoder_available;
	bool encoder_active;
	bool activation_race;
	bool settings_current;
	bool encoder_updated;
};

static void configure_stream_on_ui(void *param)
{
	struct configure_stream_task *task = param;
	config_t *profile = obs_frontend_get_profile_config();
	const char *mode = profile ? config_get_string(profile, "Output", "Mode") : NULL;
	task->advanced_mode_configured = mode && strcmp(mode, "Advanced") == 0;
	task->profile_persisted = persist_stream_encoder_settings(task->video_bitrate_kbps) &&
				  persist_audio_encoder_settings(task->audio_bitrate_kbps);
	if (!task->profile_persisted)
		return;

	obs_encoder_t *video_encoder = obs_get_encoder_by_name("advanced_video_stream");
	obs_encoder_t *audio_encoder = obs_get_encoder_by_name("adv_stream_audio");
	task->encoder_available = video_encoder != NULL;
	task->encoder_active = (video_encoder && obs_encoder_active(video_encoder)) ||
			       (audio_encoder && obs_encoder_active(audio_encoder));
	if (task->encoder_active) {
		task->settings_current = video_settings_match(video_encoder, task->video_bitrate_kbps) &&
					 audio_settings_match(audio_encoder, task->audio_bitrate_kbps);
	} else if (video_encoder) {
		obs_data_t *video_settings = obs_encoder_get_settings(video_encoder);
		apply_managed_video_settings(video_settings, task->video_bitrate_kbps);
		obs_encoder_update(video_encoder, video_settings);
		obs_data_release(video_settings);
		if (audio_encoder) {
			obs_data_t *audio_settings = obs_encoder_get_settings(audio_encoder);
			obs_data_set_int(audio_settings, "bitrate", task->audio_bitrate_kbps);
			obs_encoder_update(audio_encoder, audio_settings);
			obs_data_release(audio_settings);
		}
		if ((video_encoder && obs_encoder_active(video_encoder)) ||
		    (audio_encoder && obs_encoder_active(audio_encoder))) {
			task->encoder_active = true;
			/* The encoder may have latched its old static settings immediately
			 * before obs_encoder_update.  The settings object cannot prove that
			 * a now-active implementation accepted the update, so keep this
			 * output blocked until it is stopped and updated while inactive. */
			task->activation_race = true;
			task->settings_current = false;
		} else {
			task->encoder_updated = true;
			task->settings_current = true;
		}
	}
	if (audio_encoder)
		obs_encoder_release(audio_encoder);
	if (video_encoder)
		obs_encoder_release(video_encoder);
}

static void frontend_event(enum obs_frontend_event event, void *private_data)
{
	UNUSED_PARAMETER(private_data);
	if (event == OBS_FRONTEND_EVENT_STREAMING_STOPPING || event == OBS_FRONTEND_EVENT_STREAMING_STOPPED) {
		obs_output_t *main_output = obs_frontend_get_streaming_output();
		const bool reconnecting = main_output && obs_output_reconnecting(main_output);
		if (main_output)
			obs_output_release(main_output);
		if (reconnecting) {
			/* OBS emits the frontend stopping transition while its primary
			 * RTMP output is reconnecting. Keep Twitch alive so a short
			 * YouTube network interruption does not become a full simulcast
			 * outage. A real user stop reaches this callback with
			 * obs_output_reconnecting() false. */
			blog(LOG_INFO,
			     "[OBS Stream Manager Output] Primary stream is reconnecting; keeping Twitch output active");
			return;
		}
		/* The secondary encoder consumes the primary video pipeline. Never let
		 * it outlive that pipeline or keep sending a later Program-scene change. */
		pthread_mutex_lock(&twitch_output_mutex);
		release_twitch_output();
		pthread_mutex_unlock(&twitch_output_mutex);
		blog(LOG_INFO, "[OBS Stream Manager Output] Twitch output released with the primary stream");
		return;
	}
	if (event != OBS_FRONTEND_EVENT_PROFILE_CHANGING)
		return;
	pthread_mutex_lock(&managed_stream_mutex);
	managed_stream_configuration_applied = false;
	managed_stream_activation_race_blocked = false;
	managed_primary_video_bitrate_kbps = 0;
	managed_twitch_video_bitrate_kbps = 0;
	managed_audio_bitrate_kbps = 0;
	pthread_mutex_unlock(&managed_stream_mutex);
}

static void configure_stream(obs_data_t *request, obs_data_t *response, void *private_data)
{
	UNUSED_PARAMETER(private_data);
	const long long legacy_video_bitrate_kbps = obs_data_get_int(request, "videoBitrateKbps");
	const long long primary_video_bitrate_kbps =
		obs_data_has_user_value(request, "primaryVideoBitrateKbps")
			? obs_data_get_int(request, "primaryVideoBitrateKbps")
			: legacy_video_bitrate_kbps;
	const long long twitch_video_bitrate_kbps =
		obs_data_has_user_value(request, "twitchVideoBitrateKbps")
			? obs_data_get_int(request, "twitchVideoBitrateKbps")
			: (primary_video_bitrate_kbps > 6000 ? 6000 : primary_video_bitrate_kbps);
	const long long audio_bitrate_kbps = obs_data_get_int(request, "audioBitrateKbps");
	if (primary_video_bitrate_kbps < 500 || primary_video_bitrate_kbps > 12000 ||
	    twitch_video_bitrate_kbps < 500 || twitch_video_bitrate_kbps > 6000 ||
	    audio_bitrate_kbps < 64 || audio_bitrate_kbps > 160) {
		set_error(response, "Managed stream bitrate is outside the supported range");
		return;
	}
	pthread_mutex_lock(&managed_stream_mutex);
	const bool same_configuration = managed_primary_video_bitrate_kbps == primary_video_bitrate_kbps &&
					managed_twitch_video_bitrate_kbps == twitch_video_bitrate_kbps &&
					managed_audio_bitrate_kbps == audio_bitrate_kbps;
	const bool already_applied = same_configuration && managed_stream_configuration_applied;
	managed_primary_video_bitrate_kbps = primary_video_bitrate_kbps;
	managed_twitch_video_bitrate_kbps = twitch_video_bitrate_kbps;
	managed_audio_bitrate_kbps = audio_bitrate_kbps;
	if (!same_configuration)
		managed_stream_configuration_applied = false;
	pthread_mutex_unlock(&managed_stream_mutex);

	struct configure_stream_task task = {
		.video_bitrate_kbps = primary_video_bitrate_kbps,
		.audio_bitrate_kbps = audio_bitrate_kbps,
	};
	if (obs_in_task_thread(OBS_TASK_UI))
		configure_stream_on_ui(&task);
	else
		obs_queue_task(OBS_TASK_UI, configure_stream_on_ui, &task, true);
	if (!task.profile_persisted) {
		set_error(response, "The current OBS profile video or audio encoder settings could not be updated safely");
		return;
	}
	if (!task.advanced_mode_configured) {
		set_error(response, "OBS output mode must be Advanced before managed encoder settings can be applied");
		obs_data_set_bool(response, "profilePersisted", true);
		return;
	}
	if (!task.encoder_available) {
		set_error(response,
			  "The Advanced output handler has not loaded yet; restart OBS or reload the current profile before streaming");
		obs_data_set_bool(response, "profilePersisted", true);
		obs_data_set_bool(response, "restartRequired", true);
		return;
	}
	pthread_mutex_lock(&managed_stream_mutex);
	const bool task_is_current = managed_primary_video_bitrate_kbps == primary_video_bitrate_kbps &&
				     managed_twitch_video_bitrate_kbps == twitch_video_bitrate_kbps &&
				     managed_audio_bitrate_kbps == audio_bitrate_kbps;
	if (task_is_current) {
		if (task.activation_race) {
			managed_stream_activation_race_blocked = true;
			managed_stream_configuration_applied = false;
		} else if (task.encoder_updated && !task.encoder_active) {
			managed_stream_activation_race_blocked = false;
		}
	}
	const bool activation_race_blocked = task_is_current && managed_stream_activation_race_blocked;
	pthread_mutex_unlock(&managed_stream_mutex);
	if (!task_is_current) {
		set_error(response, "Managed stream configuration was superseded by a newer request");
		obs_data_set_bool(response, "profilePersisted", true);
		return;
	}
	if (task.encoder_active && activation_race_blocked) {
		set_error(response,
			  "The stream encoder became active while static settings were being applied; stop the active output and retry");
		obs_data_set_bool(response, "blockedByActiveEncoder", true);
		obs_data_set_bool(response, "profilePersisted", true);
		obs_data_set_bool(response, "scheduledForStreamStart", true);
		return;
	}
	if (task.encoder_active && !task.settings_current) {
		set_error(response,
			  "Managed static stream settings were saved for the next start but cannot change the active encoder");
		obs_data_set_bool(response, "blockedByActiveEncoder", true);
		obs_data_set_bool(response, "profilePersisted", true);
		obs_data_set_bool(response, "scheduledForStreamStart", true);
		return;
	}
	pthread_mutex_lock(&managed_stream_mutex);
	if (managed_primary_video_bitrate_kbps == primary_video_bitrate_kbps &&
	    managed_twitch_video_bitrate_kbps == twitch_video_bitrate_kbps &&
	    managed_audio_bitrate_kbps == audio_bitrate_kbps &&
	    !managed_stream_activation_race_blocked)
		managed_stream_configuration_applied = true;
	pthread_mutex_unlock(&managed_stream_mutex);

	obs_data_set_bool(response, "success", true);
	obs_data_set_bool(response, "advancedHandlerReady", true);
	obs_data_set_bool(response, "alreadyApplied", task.settings_current || already_applied);
	obs_data_set_bool(response, "encoderUpdated", task.encoder_updated);
	obs_data_set_bool(response, "profilePersisted", true);
	obs_data_set_bool(response, "scheduledForStreamStart", false);
	obs_data_set_int(response, "videoBitrateKbps", primary_video_bitrate_kbps);
	obs_data_set_int(response, "primaryVideoBitrateKbps", primary_video_bitrate_kbps);
	obs_data_set_int(response, "twitchVideoBitrateKbps", twitch_video_bitrate_kbps);
	obs_data_set_int(response, "audioBitrateKbps", audio_bitrate_kbps);
	blog(LOG_INFO,
	     "[OBS Stream Manager Output] Managed stream configured: primary=%lld Kbps, Twitch=%lld Kbps, audio=%lld Kbps",
	     primary_video_bitrate_kbps, twitch_video_bitrate_kbps, audio_bitrate_kbps);
}

void obs_module_post_load(void)
{
	obs_frontend_add_event_callback(frontend_event, NULL);
	vendor = obs_websocket_register_vendor("obs-stream-manager-output-v2");
	if (!vendor) {
		blog(LOG_ERROR, "[OBS Stream Manager Output] obs-websocket vendor registration failed");
		return;
	}
	if (!obs_websocket_vendor_register_request(vendor, "start_twitch", start_twitch, NULL) ||
	    !obs_websocket_vendor_register_request(vendor, "stop_twitch", stop_twitch, NULL) ||
	    !obs_websocket_vendor_register_request(vendor, "configure_stream", configure_stream, NULL) ||
	    !obs_websocket_vendor_register_request(vendor, "configure_recording", configure_recording, NULL) ||
	    !obs_websocket_vendor_register_request(vendor, "set_source_force_mono", set_source_force_mono, NULL) ||
	    !obs_websocket_vendor_register_request(vendor, "twitch_status", twitch_status, NULL))
		blog(LOG_ERROR, "[OBS Stream Manager Output] Request registration failed");
}

void obs_module_unload(void)
{
	obs_frontend_remove_event_callback(frontend_event, NULL);
	pthread_mutex_lock(&twitch_output_mutex);
	release_twitch_output();
	pthread_mutex_unlock(&twitch_output_mutex);
	pthread_mutex_destroy(&twitch_output_mutex);
	pthread_mutex_destroy(&managed_stream_mutex);
	blog(LOG_INFO, "[OBS Stream Manager Output] Plugin unloaded");
}
