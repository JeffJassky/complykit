// archiver v8 is ESM with named classes (ZipArchive, …); @types/archiver still
// describes the v6/v7 default-export factory. Declare just what we use.

declare module 'archiver' {
  import { Transform } from 'node:stream';

  export interface ArchiverOptions {
    zlib?: { level?: number };
    store?: boolean;
  }

  export interface EntryData {
    name: string;
    date?: Date | string;
    mode?: number;
  }

  export class Archiver extends Transform {
    file(filepath: string, data: EntryData): this;
    append(source: string | Buffer | NodeJS.ReadableStream, data: EntryData): this;
    finalize(): Promise<void>;
    abort(): this;
    pointer(): number;
  }

  export class ZipArchive extends Archiver {
    constructor(options?: ArchiverOptions);
  }
}
