export function ServiceIcon({ service }: { service: 'obs' | 'youtube' | 'twitch' }) {
  if (service === 'youtube') return <svg className="service-icon youtube" viewBox="0 0 24 24" aria-hidden="true"><path d="M21.6 7.2a2.7 2.7 0 0 0-1.9-1.9C18 4.8 12 4.8 12 4.8s-6 0-7.7.5a2.7 2.7 0 0 0-1.9 1.9A28 28 0 0 0 2 12a28 28 0 0 0 .4 4.8 2.7 2.7 0 0 0 1.9 1.9c1.7.5 7.7.5 7.7.5s6 0 7.7-.5a2.7 2.7 0 0 0 1.9-1.9A28 28 0 0 0 22 12a28 28 0 0 0-.4-4.8Z" /><path className="service-icon-cut" d="m10 15.5 5-3.5-5-3.5Z" /></svg>
  if (service === 'twitch') return <svg className="service-icon twitch" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h17v12l-5 5h-4l-3 3v-3H4Zm3 3v10h4v2l2-2h4l2-2V6Z" /><path className="service-icon-cut" d="M10 8h2v5h-2Zm5 0h2v5h-2Z" /></svg>
  return <svg className="service-icon obs" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" /><circle cx="12" cy="12" r="2.5" /></svg>
}
