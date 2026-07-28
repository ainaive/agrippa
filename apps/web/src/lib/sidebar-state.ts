/**
 * Parse the sidebar's persisted open state out of a cookie string. The
 * vendored sidebar writes `sidebar_state=true|false`; unlike shadcn's Next.js
 * starter — where the server reads it into `defaultOpen` — this SPA must read
 * it back client-side or the collapse choice is discarded on every reload.
 * Anything other than an explicit `false` means open (the shadcn default).
 */
export function sidebarStateFromCookie(cookie: string): boolean {
  const match = cookie.match(/(?:^|;\s*)sidebar_state=(true|false)(?:;|$)/);
  return match ? match[1] === "true" : true;
}
