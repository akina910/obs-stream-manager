import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('OBS recording-only native preset', () => {
  it('registers a separate fixed NVENC recording request without replacing stream configuration', async () => {
    const source = await readFile(new URL('./src/plugin-main.c', import.meta.url), 'utf8')

    expect(source).toContain('"configure_stream", configure_stream')
    expect(source).toContain('"configure_recording", configure_recording')
    expect(source).toContain('obs_get_encoder_by_name("advanced_video_recording")')
    expect(source).toContain('obs_data_set_string(settings, "rate_control", "VBR")')
    expect(source).toContain('obs_data_unset_user_value(settings, "cqp")')
    expect(source).toContain('obs_data_set_int(settings, "bitrate", video_bitrate_kbps)')
    expect(source).toContain('obs_data_set_int(settings, "max_bitrate", max_video_bitrate_kbps)')
    expect(source).toContain('max_video_bitrate_kbps < video_bitrate_kbps || max_video_bitrate_kbps > 10000')
    expect(source).toContain('obs_data_set_string(response, "rateControl", "VBR")')
    expect(source).toContain('obs_data_set_string(settings, "preset", "p5")')
    expect(source).toContain('obs_data_set_string(settings, "multipass", "disabled")')
    expect(source).toContain('obs_data_set_bool(settings, "lookahead", false)')
    expect(source).toContain('obs_data_set_bool(settings, "adaptive_quantization", false)')
    expect(source).toContain('config_set_bool(profile, "General", "AutoRemux", true)')
    expect(source).toContain('config_set_string(profile, "AdvOut", "RecFormat2", "mkv")')
    expect(source).toContain('config_set_uint(profile, "Audio", "SampleRate", 48000)')
  })

  it('blocks active outputs before writing any recording settings', async () => {
    const source = await readFile(new URL('./src/plugin-main.c', import.meta.url), 'utf8')
    const configure = source.slice(source.indexOf('static void configure_recording_on_ui'))
    expect(configure.indexOf('if (task->outputs_active)')).toBeLessThan(configure.indexOf('persist_recording_encoder_settings('))
  })
})
