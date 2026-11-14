// This bootstrap must precede the bundled modules (TypeBox constructs an encoder
// during module initialization). UTF-8 conversion is provided by Foundation.
if (!globalThis.TextEncoder) {
  globalThis.TextEncoder = class {
    get encoding() { return 'utf-8' }
    encode(value = '') { return new Uint8Array(JSON.parse(__guguUTF8Encode(String(value)))) }
    encodeInto(value, destination) {
      let read = 0
      let written = 0
      for (const character of String(value)) {
        const bytes = this.encode(character)
        if (written + bytes.length > destination.length) break
        destination.set(bytes, written)
        written += bytes.length
        read += character.length
      }
      return { read, written }
    }
  }
}
