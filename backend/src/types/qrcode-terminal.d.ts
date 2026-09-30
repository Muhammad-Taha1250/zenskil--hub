// qrcode-terminal ships no TypeScript declarations.
declare module 'qrcode-terminal' {
  export function generate(text: string, opts?: { small?: boolean }): void;
  export function setErrorLevel(level: string): void;
  const qrcode: {
    generate: typeof generate;
    setErrorLevel: typeof setErrorLevel;
  };
  export default qrcode;
}
