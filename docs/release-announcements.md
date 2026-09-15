# Release announcements

Optional short Homey timeline messages, bundled with the app. No external service or analytics.

## Preparing a release

Always consider an announcement for a major feature release; routine fixes usually need none.
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

## Announcement in 1.3.3

The active `1.3.3-setup-tips` announcement contains two snippets, both restricted to `nibe_s`, so each owner sees only relevant news:

### Hot Water (`roles: ['hotwater']`)

Hot water available is here. Run Repair on your Hot Water device to set it up.

### Heating (`roles: ['heating']`)

You can now use your Homey temperature sensors for heating. Run Repair on your Heating device to set it up.

Both snippets are translated into English, Swedish, German, Dutch, Norwegian and Danish.
Keep this ID on later patches to avoid repeating the same tips.
