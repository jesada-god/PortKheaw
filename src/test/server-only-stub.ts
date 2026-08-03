/**
 * Stands in for the `server-only` package under Vitest.
 *
 * That package deliberately throws unless it is resolved with Node's
 * `react-server` condition, which is how importing a server module from a client
 * bundle becomes a build error. Vitest resolves without that condition, so every
 * module carrying `import 'server-only'` would throw on import and could only be
 * tested by reading its source as text.
 *
 * Aliasing it to this empty module lets those modules be imported and exercised
 * directly. The guarantee itself is not weakened: it is enforced by the Next
 * build, which is one of this phase's gates, not by the test runner.
 */
export {};
