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
#include <util/threading.h>

#ifdef _WIN32
#include <windows.h>
#endif

#include "obs-websocket-api.h"

OBS_DECLARE_MODULE()
OBS_MODULE_AUTHOR("OBS Stream Manager contributors")

#define OBS_STREAM_MANAGER_OUTPUT_API_VERSION 1

static obs_websocket_vendor vendor;
static obs_output_t *twitch_output;
static obs_service_t *twitch_service;
static pthread_mutex_t managed_stream_mutex;
static bool managed_stream_configuration_pending;
static long long managed_video_bitrate_kbps;
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

static void release_twitch_output(void)
{
	if (twitch_output) {
		if (obs_output_active(twitch_output))
			obs_output_force_stop(twitch_output);
		obs_output_release(twitch_output);
		twitch_output = NULL;
	}
	if (twitch_service) {
		obs_service_release(twitch_service);
		twitch_service = NULL;
	}
}

static void start_twitch(obs_data_t *request, obs_data_t *response, void *private_data)
{
	UNUSED_PARAMETER(private_data);
	const char *server = obs_data_get_string(request, "server");
	const char *key = obs_data_get_string(request, "key");
	if (!server || !*server || !key || !*key) {
		set_error(response, "Twitch server or stream key is missing");
		return;
	}

	obs_output_t *main_output = obs_frontend_get_streaming_output();
	if (!main_output || !obs_output_active(main_output)) {
		if (main_output)
			obs_output_release(main_output);
		set_error(response, "The primary OBS stream must be active before Twitch starts");
		return;
	}

	obs_encoder_t *video_encoder = obs_output_get_video_encoder(main_output);
	obs_encoder_t *audio_encoder = obs_output_get_audio_encoder(main_output, 0);
	if (!video_encoder || !audio_encoder) {
		obs_output_release(main_output);
		set_error(response, "The primary OBS stream encoders are unavailable");
		return;
	}

	release_twitch_output();
	obs_data_t *service_settings = obs_data_create();
	obs_data_set_string(service_settings, "server", server);
	obs_data_set_string(service_settings, "key", key);
	obs_data_set_bool(service_settings, "use_auth", false);
	twitch_service = obs_service_create("rtmp_custom", "obs_stream_manager_twitch_service", service_settings, NULL);
	obs_data_release(service_settings);
	if (!twitch_service) {
		obs_output_release(main_output);
		set_error(response, "Unable to create the Twitch RTMP service");
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
		return;
	}

	obs_output_set_service(twitch_output, twitch_service);
	obs_output_set_video_encoder(twitch_output, video_encoder);
	obs_output_set_audio_encoder(twitch_output, audio_encoder, 0);
	obs_output_release(main_output);

	if (!obs_output_start(twitch_output)) {
		const char *last_error = obs_output_get_last_error(twitch_output);
		set_error(response, last_error && *last_error ? last_error : "OBS rejected the Twitch output start request");
		release_twitch_output();
		return;
	}

	obs_data_set_bool(response, "success", true);
	obs_data_set_bool(response, "outputActive", true);
	blog(LOG_INFO, "[OBS Stream Manager Output] Twitch output started");
}

static void stop_twitch(obs_data_t *request, obs_data_t *response, void *private_data)
{
	UNUSED_PARAMETER(request);
	UNUSED_PARAMETER(private_data);
	release_twitch_output();
	obs_data_set_bool(response, "success", true);
	obs_data_set_bool(response, "outputActive", false);
	blog(LOG_INFO, "[OBS Stream Manager Output] Twitch output stopped");
}

static void twitch_status(obs_data_t *request, obs_data_t *response, void *private_data)
{
	UNUSED_PARAMETER(request);
	UNUSED_PARAMETER(private_data);
	const bool active = twitch_output && obs_output_active(twitch_output);
	obs_data_set_bool(response, "success", true);
	obs_data_set_string(response, "pluginVersion", OBS_STREAM_MANAGER_OUTPUT_VERSION);
	obs_data_set_int(response, "apiVersion", OBS_STREAM_MANAGER_OUTPUT_API_VERSION);
	obs_data_set_bool(response, "outputActive", active);
	obs_data_set_int(response, "bytesSent", twitch_output ? (long long)obs_output_get_total_bytes(twitch_output) : 0);
	obs_data_set_int(response, "totalFrames", twitch_output ? (long long)obs_output_get_total_frames(twitch_output) : 0);
	obs_data_set_int(response, "skippedFrames", twitch_output ? (long long)obs_output_get_frames_dropped(twitch_output) : 0);
}

bool obs_module_load(void)
{
	if (pthread_mutex_init(&managed_stream_mutex, NULL) != 0) {
		blog(LOG_ERROR, "[OBS Stream Manager Output] Managed stream mutex initialization failed");
		return false;
	}
	#ifdef _WIN32
	launch_companion_app();
	#endif
	blog(LOG_INFO, "[OBS Stream Manager Output] Plugin loaded");
	return true;
}

static bool configure_stream_encoders(obs_output_t *output, long long video_bitrate_kbps,
				      long long audio_bitrate_kbps, obs_data_t *response)
{
	if (!output) {
		if (response)
			set_error(response, "The primary OBS stream output is unavailable");
		else
			blog(LOG_WARNING, "[OBS Stream Manager Output] Primary stream output is unavailable");
		return false;
	}

	obs_encoder_t *video_encoder = obs_output_get_video_encoder(output);
	obs_encoder_t *audio_encoder = obs_output_get_audio_encoder(output, 0);
	if (!video_encoder || !audio_encoder) {
		if (response)
			set_error(response, "The primary OBS stream encoders are unavailable");
		else
			blog(LOG_WARNING, "[OBS Stream Manager Output] Primary stream encoders are unavailable");
		return false;
	}

	obs_data_t *video_settings = obs_encoder_get_settings(video_encoder);
	obs_data_set_string(video_settings, "rate_control", "CBR");
	obs_data_set_int(video_settings, "bitrate", video_bitrate_kbps);
	obs_data_set_int(video_settings, "keyint_sec", 2);
	obs_data_set_int(video_settings, "bf", 2);
	obs_encoder_update(video_encoder, video_settings);
	obs_data_release(video_settings);

	obs_data_t *audio_settings = obs_encoder_get_settings(audio_encoder);
	obs_data_set_int(audio_settings, "bitrate", audio_bitrate_kbps);
	obs_encoder_update(audio_encoder, audio_settings);
	obs_data_release(audio_settings);

	if (response) {
		obs_data_set_bool(response, "success", true);
		obs_data_set_int(response, "videoBitrateKbps", video_bitrate_kbps);
		obs_data_set_int(response, "audioBitrateKbps", audio_bitrate_kbps);
	}
	return true;
}

static void frontend_event(enum obs_frontend_event event, void *private_data)
{
	UNUSED_PARAMETER(private_data);
	if (event != OBS_FRONTEND_EVENT_STREAMING_STARTING)
		return;

	pthread_mutex_lock(&managed_stream_mutex);
	const bool pending = managed_stream_configuration_pending;
	const long long video_bitrate_kbps = managed_video_bitrate_kbps;
	const long long audio_bitrate_kbps = managed_audio_bitrate_kbps;
	pthread_mutex_unlock(&managed_stream_mutex);
	if (!pending)
		return;

	obs_output_t *main_output = obs_frontend_get_streaming_output();
	if (!main_output) {
		blog(LOG_WARNING, "[OBS Stream Manager Output] Managed stream settings could not be applied before start");
		return;
	}

	if (configure_stream_encoders(main_output, video_bitrate_kbps, audio_bitrate_kbps, NULL)) {
		blog(LOG_INFO,
		     "[OBS Stream Manager Output] Applied managed stream settings before start: video=%lld Kbps, audio=%lld Kbps, keyframe=2 seconds, B-frames=2",
		     video_bitrate_kbps, audio_bitrate_kbps);
		pthread_mutex_lock(&managed_stream_mutex);
		if (managed_stream_configuration_pending && managed_video_bitrate_kbps == video_bitrate_kbps &&
		    managed_audio_bitrate_kbps == audio_bitrate_kbps)
			managed_stream_configuration_pending = false;
		pthread_mutex_unlock(&managed_stream_mutex);
	}
	obs_output_release(main_output);
}

static void configure_stream(obs_data_t *request, obs_data_t *response, void *private_data)
{
	UNUSED_PARAMETER(private_data);
	const long long video_bitrate_kbps = obs_data_get_int(request, "videoBitrateKbps");
	const long long audio_bitrate_kbps = obs_data_get_int(request, "audioBitrateKbps");
	if (video_bitrate_kbps < 500 || video_bitrate_kbps > 6000 || audio_bitrate_kbps < 64 ||
	    audio_bitrate_kbps > 160) {
		set_error(response, "Managed stream bitrate is outside the supported range");
		return;
	}
	pthread_mutex_lock(&managed_stream_mutex);
	managed_video_bitrate_kbps = video_bitrate_kbps;
	managed_audio_bitrate_kbps = audio_bitrate_kbps;
	managed_stream_configuration_pending = true;
	pthread_mutex_unlock(&managed_stream_mutex);

	obs_output_t *main_output = obs_frontend_get_streaming_output();
	if (!main_output || !obs_output_active(main_output)) {
		obs_data_set_bool(response, "success", true);
		obs_data_set_bool(response, "scheduledForStreamStart", true);
		obs_data_set_int(response, "videoBitrateKbps", video_bitrate_kbps);
		obs_data_set_int(response, "audioBitrateKbps", audio_bitrate_kbps);
		if (main_output)
			obs_output_release(main_output);
		return;
	}
	const bool configured = configure_stream_encoders(main_output, video_bitrate_kbps, audio_bitrate_kbps, response);
	obs_output_release(main_output);
	if (configured) {
		pthread_mutex_lock(&managed_stream_mutex);
		if (managed_stream_configuration_pending && managed_video_bitrate_kbps == video_bitrate_kbps &&
		    managed_audio_bitrate_kbps == audio_bitrate_kbps)
			managed_stream_configuration_pending = false;
		pthread_mutex_unlock(&managed_stream_mutex);
	}
}

void obs_module_post_load(void)
{
	obs_frontend_add_event_callback(frontend_event, NULL);
	vendor = obs_websocket_register_vendor("obs-stream-manager-output");
	if (!vendor) {
		blog(LOG_ERROR, "[OBS Stream Manager Output] obs-websocket vendor registration failed");
		return;
	}
	if (!obs_websocket_vendor_register_request(vendor, "start_twitch", start_twitch, NULL) ||
	    !obs_websocket_vendor_register_request(vendor, "stop_twitch", stop_twitch, NULL) ||
	    !obs_websocket_vendor_register_request(vendor, "configure_stream", configure_stream, NULL) ||
	    !obs_websocket_vendor_register_request(vendor, "twitch_status", twitch_status, NULL))
		blog(LOG_ERROR, "[OBS Stream Manager Output] Request registration failed");
}

void obs_module_unload(void)
{
	obs_frontend_remove_event_callback(frontend_event, NULL);
	release_twitch_output();
	pthread_mutex_destroy(&managed_stream_mutex);
	blog(LOG_INFO, "[OBS Stream Manager Output] Plugin unloaded");
}
