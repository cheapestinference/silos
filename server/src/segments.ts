// segments.ts — the path-segment vocabulary the routes share (split out of
// server.ts with routes/): PARAM accepts one id segment
// (word chars, dots, dashes — never a slash), and PURE_DOTS names the
// all-dot segments ('.', '..', '…') that every path rule must refuse even
// though PARAM matches them.
export const PARAM = /^[\w.-]+$/
export const PURE_DOTS = /^\.+$/
