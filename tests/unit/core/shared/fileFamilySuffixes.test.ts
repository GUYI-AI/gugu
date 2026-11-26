import { expect, it } from 'vitest'
import { fileFamily } from '@gugu/core/shared/fileFamily.mjs'

it("keeps HEIF and TIFF files in the image family without a declared MIME", () => {
  for (const [name, mime, family] of [["photo.heif", "", "image"], ["scan.tif", "", "image"], ["scan.TIFF", "", "image"]]) {
    expect(fileFamily(name, mime)).toBe(family)
  }
})
