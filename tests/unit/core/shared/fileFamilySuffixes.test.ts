import { expect, it } from 'vitest'
import { fileFamily } from '@gugu/core/shared/fileFamily.mjs'

it("keeps HEIF and TIFF files in the image family without a declared MIME", () => {
  for (const [name, mime, family] of [["photo.heif", "", "image"], ["scan.tif", "", "image"], ["scan.TIFF", "", "image"]]) {
    expect(fileFamily(name, mime)).toBe(family)
  }
})

it("classifies animated PNG and JFIF images by their suffix", () => {
  for (const [name, mime, family] of [["animation.apng", "", "image"], ["photo.jfif", "", "image"]]) {
    expect(fileFamily(name, mime)).toBe(family)
  }
})

it("recognizes C++ headers and source aliases already supported by the MIME table", () => {
  for (const [name, mime, family] of [["main.cc", "", "code"], ["api.hpp", "", "code"], ["Program.cs", "", "code"]]) {
    expect(fileFamily(name, mime)).toBe(family)
  }
})

it("keeps bash and zsh source files in the code family", () => {
  for (const [name, mime, family] of [["build.bash", "", "code"], ["profile.zsh", "", "code"], ["script", "text/x-shellscript", "code"]]) {
    expect(fileFamily(name, mime)).toBe(family)
  }
})

it("classifies configuration suffixes known to MIME inference as text", () => {
  for (const [name, mime, family] of [["config.toml", "", "text"], ["settings.ini", "", "text"], ["service.conf", "", "text"], ["notes.markdown", "", "text"]]) {
    expect(fileFamily(name, mime)).toBe(family)
  }
})

it("recognizes macro-enabled Office documents without MIME metadata", () => {
  for (const [name, mime, family] of [["report.docm", "", "word"], ["budget.xlsm", "", "sheet"], ["deck.pptm", "", "slides"]]) {
    expect(fileFamily(name, mime)).toBe(family)
  }
})
