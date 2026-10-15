/**
 * English strings for the lightning guard UI. They are the i18next
 * `defaultValue`s (lgT below) and the source of the matching keys in
 * src/lang/en.json, so the two cannot drift apart.
 */
export const LG_EN = {
  'lightningGuard.allClearIn': 'All-clear in {{countdown}}',
  'lightningGuard.bannerLast': 'last strike {{time}}',
  'lightningGuard.hide': 'Hide',
  'lightningGuard.lastStrike': 'Last strike {{time}} ({{age}} ago, {{distance}})',
  'lightningGuard.level.alarm': 'LIGHTNING ALARM',
  'lightningGuard.level.clear': 'All clear',
  'lightningGuard.level.warn': 'Lightning warning',
  'lightningGuard.nearest': 'Nearest strike {{distance}}',
  'lightningGuard.noStrikes': 'No strikes within {{radius}}',
  'lightningGuard.override.auto': 'Auto',
  'lightningGuard.override.label': 'Relay',
  'lightningGuard.override.off': 'Hold connected',
  'lightningGuard.override.offHint': '"Hold connected" ends by itself at the next all-clear.',
  'lightningGuard.override.on': 'Force protect',
  'lightningGuard.pin.description':
    "Which Raspberry Pi GPIO line drives the lightning relay (the GPIO plugin's lightningOut). The browser asks for the relay through the same connection as the other indicator lines; switch the relay on under Settings → Alerts → Lightning guard.",
  'lightningGuard.pin.failSafe': 'Fail-safe: energise the relay to keep the antenna connected',
  'lightningGuard.pin.failSafeHint':
    'With fail-safe on, power loss, a crash or a stopped Rig Bridge releases the relay and the antenna is disconnected. Wire the antenna through the contacts that close when the coil is energised (NO).',
  'lightningGuard.pin.gpioOff':
    'The GPIO plugin is not running — enable "Raspberry Pi GPIO" on the Rig Bridge setup page (Plugins).',
  'lightningGuard.pin.gpioRunning': 'GPIO plugin running ({{backend}}) · lightning relay: {{relay}}',
  'lightningGuard.pin.hold': 'Keep the relay engaged when the browser goes quiet',
  'lightningGuard.pin.needsBridge': 'Enable Rig Bridge above to assign the relay line.',
  'lightningGuard.pin.pin': 'Relay GPIO (BCM)',
  'lightningGuard.pin.pinHint': 'empty = off · suggested 25 (header pin 22) · "P22" also works',
  'lightningGuard.pin.placeholder': 'off',
  'lightningGuard.pin.push': 'Push to Rig Bridge',
  'lightningGuard.pin.pushed': 'Saved in Rig Bridge',
  'lightningGuard.pin.reload': 'Reload',
  'lightningGuard.pin.title': 'Lightning relay (GPIO)',
  'lightningGuard.pin.unreachable': 'Rig Bridge not reachable',
  'lightningGuard.pin.wiring':
    'A Pi pin gives 3.3 V and a few mA: drive a relay MODULE (transistor + flyback diode on board), never a bare coil. Use a relay or coax switch rated for your RF power, and disconnect only on receive. This is a convenience, not lightning protection — it does not replace grounding, bonding and surge arrestors.',
  'lightningGuard.relay.bridge': 'Rig Bridge line: {{state}}',
  'lightningGuard.relay.bridgeOff': 'released',
  'lightningGuard.relay.bridgeOn': 'engaged',
  'lightningGuard.relay.engaged': 'Antenna relay ENGAGED (antenna disconnected)',
  'lightningGuard.relay.engagedShort': 'antenna relay engaged',
  'lightningGuard.relay.released': 'Antenna relay released',
  'lightningGuard.settings.alarmRadius': 'Alarm radius',
  'lightningGuard.settings.allClear': 'All-clear after',
  'lightningGuard.settings.channelNotify': 'Browser notification',
  'lightningGuard.settings.channelPush': "Web Push to this server's subscribers",
  'lightningGuard.settings.channelSpeech': 'Spoken alert',
  'lightningGuard.settings.channelTone': 'Tone',
  'lightningGuard.settings.channels': 'Alert with',
  'lightningGuard.settings.description':
    'Watches real-time lightning (Blitzortung.org) around your station — also while the Lightning map layer is off. A strike inside the warning radius raises a warning, one inside the alarm radius an alarm; the all-clear comes after the set time without strikes nearby. Optional: a Rig Bridge relay disconnects the antenna during the alarm.',
  'lightningGuard.settings.hysteresisNote':
    'A level is held by strikes up to {{pct}} % beyond its radius, so a storm on the edge does not flap the alarm. Defaults: {{defaultWarn}} km warning, {{defaultAlarm}} km alarm.',
  'lightningGuard.settings.minStrikes': 'Strikes needed',
  'lightningGuard.settings.minStrikesSuffix': 'within 10 min',
  'lightningGuard.settings.noLocation':
    'Set your station location (Settings → Station) — distances are measured from DE.',
  'lightningGuard.settings.notifyNeedsPermission':
    'Turn on Browser Notifications at the top of this tab to allow notifications.',
  'lightningGuard.settings.previewTone': 'Preview tone',
  'lightningGuard.settings.pushUnavailable':
    'This server does not send lightning pushes (self-hosters: PUSH_LIGHTNING_BROADCAST=true plus the Web Push keys; see the manual).',
  'lightningGuard.settings.relayEnable': 'Drive the Rig Bridge lightning relay (GPIO lightningOut)',
  'lightningGuard.settings.relayHowTo':
    'Needs Rig Bridge enabled (local, not Cloud Relay) with the GPIO plugin running and a relay line assigned in Settings → Rig Bridge. The relay releases automatically at the all-clear; the header ⚡ menu has a manual override.',
  'lightningGuard.settings.relayOn': 'Engage the relay at',
  'lightningGuard.settings.relayOnAlarm': 'Alarm',
  'lightningGuard.settings.relayOnWarn': 'Warning',
  'lightningGuard.settings.relayTitle': 'Antenna relay',
  'lightningGuard.settings.safetyTitle': 'Not a safety device.',
  'lightningGuard.settings.safetyText':
    'The guard is a convenience. Lightning data can be late, incomplete or missing, and the browser or network can fail. It does not replace proper grounding, bonding, surge arrestors and disconnecting by hand when a storm is coming.',
  'lightningGuard.settings.simulateAlarm': 'Simulate alarm strike',
  'lightningGuard.settings.simulateWarn': 'Simulate warning strike',
  'lightningGuard.settings.statusOff': 'Waiting for the station location.',
  'lightningGuard.settings.test': 'Test:',
  'lightningGuard.settings.testNote':
    'A simulated strike runs the whole chain — alerts, banner, EmComm log and the relay — and shows on the Lightning map layer. With "Strikes needed" above 1, click more than once.',
  'lightningGuard.settings.title': 'Lightning guard',
  'lightningGuard.settings.tone': 'Lightning guard tone',
  'lightningGuard.settings.warnRadius': 'Warning radius',
  'lightningGuard.simulated': 'simulated',
  'lightningGuard.rate': '{{count}} strike(s) within {{radius}} in 10 min',
  'lightningGuard.title': 'Lightning guard',
};

/** t() with the English default from LG_EN. */
export function lgT(t, key, vars) {
  return t(key, { defaultValue: LG_EN[key] ?? key, ...(vars || {}) });
}
