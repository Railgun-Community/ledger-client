/**
 * Where the bundled RAILGUN app builds live: `apps/{DEVICE_OS}/{target}/{APP_VERSION}/`.
 *
 * DEVICE_OS is the Ledger OS line the build loads on — the firmware release names its
 * files for the device OS (e.g. `app_flex_v1.6.0`), and a build for Ledger API level 26
 * loads on any 1.6.x device. APP_VERSION is the RAILGUN app's own version (the Makefile
 * `APPVERSION`, what `GET_VERSION` returns). Bump them when shipping a new build.
 */

export const DEVICE_OS = '1.6.x';
export const APP_VERSION = '0.0.2';

export const BUNDLED_TARGETS = ['nanosp', 'flex'] as const;
export type BundledTarget = typeof BUNDLED_TARGETS[number];

/** Repo-relative path of one bundled file, e.g. `apps/1.6.x/flex/0.0.2/app.elf`. */
export function bundledAppPath(target: BundledTarget, file: 'app.apdu' | 'app.elf'): string {
  return `apps/${DEVICE_OS}/${target}/${APP_VERSION}/${file}`;
}
