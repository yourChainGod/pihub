export const DESKTOP_PRODUCT_NAME = "PiHub Desktop";
export const DESKTOP_PACKAGE_NAME = "pihub-desktop";
export const DESKTOP_BINARY_NAME = "pihub-desktop";
export const DESKTOP_BUNDLE_IDENTIFIER = "io.github.yourchaingod.pihub.desktop";
export const DESKTOP_KEYRING_SERVICE = `${DESKTOP_BUNDLE_IDENTIFIER}.auth.v1`;

export const DESKTOP_RELEASE_REPOSITORY = "yourChainGod/pihub";
export const DESKTOP_UPDATE_MANIFEST_NAME = "pihub-desktop-v1.json";
export const DESKTOP_UPDATE_SIGNATURE_NAME = `${DESKTOP_UPDATE_MANIFEST_NAME}.sig`;
export const DESKTOP_UPDATE_CHANNEL = "desktop-v1-stable";
export const DESKTOP_UPDATE_KIND = "pihub.desktop-v1-update-manifest";
export const DESKTOP_UPDATER_ENDPOINT =
  `https://github.com/${DESKTOP_RELEASE_REPOSITORY}/releases/latest/download/${DESKTOP_UPDATE_MANIFEST_NAME}`;
export const DESKTOP_UPDATER_SIGNATURE_ENDPOINT =
  `https://github.com/${DESKTOP_RELEASE_REPOSITORY}/releases/latest/download/${DESKTOP_UPDATE_SIGNATURE_NAME}`;

export const LEGACY_DESKTOP_PRODUCT_NAME = "PiHub";
export const LEGACY_DESKTOP_BUNDLE_IDENTIFIER = "dev.pihub.desktop";
export const LEGACY_DESKTOP_KEYRING_SERVICE = "com.pihub.desktop.auth.v1";
