// upload.ts — a picked or dropped file as the base64 body the upload
// routes take (the data URL's payload, without its `data:…;base64,` head).
export function readBase64(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result)
      const i = s.indexOf(',')
      res(i >= 0 ? s.slice(i + 1) : s)
    }
    r.onerror = () => rej(new Error('failed to read the file'))
    r.readAsDataURL(file)
  })
}
