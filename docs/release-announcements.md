# Release announcements

Optional short Homey timeline messages, bundled with the app. No external service or analytics.

## Preparing a release

Always ask the user whether a release should include a timeline message, including patch releases,
unless they have already explicitly decided for that release.
Use a short benefit followed by a concrete setup step. Homey already shows the app version elsewhere.

Set `CURRENT_ANNOUNCEMENT` in `lib/release-announcements.ts` to an `Announcement`:

- `id`: a unique, stable feature-release identifier. Keep it across patches and copy edits.
- `snippets`: short messages, each with `text.en` and translated language keys (English fallback).
- Optional `driverIds` and `roles`: both filters must match the same paired device. Omit them for
  general app news (still requires at least one paired device).

Keep only the latest announcement. Set it to `null` when no announcement should be active.
Translate into the app's supported languages before enabling a release message.

## Delivery

App startup launches delivery in the background, reads Homey's persisted paired-device inventory through the existing Homey API permission without waiting for a live pump connection. Matching snippets are combined into one notification;
multiple pumps/devices don't duplicate snippets. A persisted list of handled IDs prevents repeat delivery
on normal restarts, patches and rollbacks. Fresh installs and unrelated devices consume the ID silently,
so adding a device later doesn't produce stale release news. Skipping releases produces only current news.

Notification errors are logged and retry on the next app start. Delivery and settings persistence are not
an atomic transaction: a crash after Homey accepts a notification but before its ID is saved can repeat it.
This is a timeline entry; phone push behavior follows Homey's notification settings.

## Announcement in 1.4.5

The active `1.4.5-update` replaces `1.4.4-setting-triggers` and summarises everything since 1.4.2,
so owners who were on 1.4.2 get one message. It keeps the two 1.4.4 snippets (S-series heating and
cooling, unchanged) and adds one untargeted snippet for every owner:

### All devices

Keep your heat pump's software up to date: older versions can report wrong energy and COP figures. Approve updates in the myUplink app or on the pump, then run Repair on your Nibe devices.

Owners already shown the 1.4.4 message on the test channel see its two snippets again; the
new ID is what lets 1.4.2 owners receive them at all. All snippets are in all six languages.

## Announcement in 1.4.4

The active `1.4.4-setting-triggers` replaces `1.4-feature-update`. Both snippets target
S-series only and are combined into one message for an owner with both devices.

### Heating device

New Flow cards react when the heat curve displacement, operating mode or fan mode changes. Add them to a Flow from your Nibe devices.

### Cooling device

Night cooling has moved to your Nibe heating device. Pick that device again in Flows that switch night cooling.

The cooling snippet goes to every cooling-device owner, not only those who used night cooling:
the app cannot see which Flows use a card. Both snippets are translated into all six languages.

## Announcement in 1.4.1

The then-active `1.4-feature-update` replaces the 1.3.3 tips. It targets owners by driver,
combining both snippets into one message for owners with both series.

### S-series

More control in Flows: dedicated setting cards and SG Ready controls where supported and configured. Explore the new Nibe Flow cards; existing Flows keep working.

### F-series

Experimental F-series support has improved readings and energy recommendations. Run Repair on your Nibe devices to review the available features.

Both snippets are translated into all six supported languages. Keep the ID stable across
subsequent patches so users receive this feature announcement only once.
