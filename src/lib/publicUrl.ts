/**
 * A file from public/, resolved against the site's base path: "/" locally,
 * "/mc-test/" when served as a GitHub Pages project site.
 */
export const publicUrl = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`
