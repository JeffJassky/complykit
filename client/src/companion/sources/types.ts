// A source adapter reads the site's banner. `start(push)` runs once: it attaches the banner's change
// listeners (each calls `push(grantedBannerIds)` when it can read the choice) and returns an optional
// `poll()` the framework calls every 250 ms (up to 10 s) until the banner has answered once: it returns
// the granted banner ids, or undefined while the banner's API is not there yet.
export type Granted = string[];
export type Poll = () => Granted | undefined | Promise<Granted | undefined>;
export type Source = (push: (granted: Granted) => void) => Poll | void;

export type W = Record<string, any>;
export const win = (): W => window as unknown as W;

/** addEventListener on `target`, `names` space-separated; `fn` runs on each event. */
export const listen = (target: EventTarget, names: string, fn: (e: Event) => void): void => {
  for (const n of names.split(' ')) target.addEventListener(n, fn);
};
