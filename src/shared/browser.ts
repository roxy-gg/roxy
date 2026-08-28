/**
 * Height reserved for the browser window's React chrome: tab strip + URL bar.
 *
 * Main needs this to place the native BrowserView pages below the chrome; the
 * renderer needs it when temporarily reserving extra chrome space for menus.
 * Keep one value so the page view cannot drift under the toolbar.
 */
export const BROWSER_CHROME_H = 80
