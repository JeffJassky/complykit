// The tool's own version, as stamped into every consent record (`toolVersion`).
export const TOOL_VERSION = '0.0.0';
declare const __CK_BUILD__: string | undefined;
/** Content hash of the client source (tsup define; 'dev' when unbundled). Pins the UI / add-on URLs (?v=) and is `ComplyKit.build`. */
export const BUILD = typeof __CK_BUILD__ === 'string' ? __CK_BUILD__ : 'dev';
