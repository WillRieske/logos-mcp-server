// tests/helpers/removed-driver-commands.ts
// The clipboard, mouse and panel-reading driver commands removed for the
// Logos terms. Shared so the source guard and the real-script test check the
// same list.
export const REMOVED_DRIVER_COMMANDS = [
  "click", "shiftClick", "drag", "wheel", "copy", "readClipboard", "clearClipboard",
  "saveClipboard", "restoreClipboard", "setCursor", "panels", "selectTab", "clipboardHistory",
] as const;
