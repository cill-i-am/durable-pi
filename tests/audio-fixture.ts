import { createHash } from "node:crypto"

// A real, short mono Opus/Ogg tone. Provider inference is synthetic in tests.
export const audioBase64 =
  "T2dnUwACAAAAAAAAAAAg1wTGAAAAADTJWhUBE09wdXNIZWFkAQE4AcBdAAAAAABPZ2dTAAAAAAAAAAAAACDXBMYBAAAAhf9N4AE8T3B1c1RhZ3MMAAAATGF2ZjYzLjEuMTAyAQAAABwAAABlbmNvZGVyPUxhdmM2My4xLjEwMiBsaWJvcHVzT2dnUwAEuCYAAAAAAAAg1wTGAgAAAJxMDc0LSSgvNDUxMyo2LhhogdS3bH5A5gAAD+56Tegyn8TTPYbBRG91oyGfdh1+QRb7dH/ynfZWWbOBhq516vAJCOMn4dXrtOUXPigMaz0o32PyQ0RJwTFWaKH3wef/g17uegrB3FFl7d7UJ6+ziVbELnjLGu8klLDbPPCOfLzR1miboxJTqkhMz/evekhLK8c3SypTdsjnXTqAhH2jVZse5TbuAmOa6V/jXMuI3pd5aJujX3Wc/ElKN2hgFTvd3tjo+0gAKhANhhqPwZvP3nOE8ax1AJJuY1u6AR48gr4YZrcMgGibo191mEp9bAeelolL/7CqEV6RhvTthw3oM6dfKIk7IsR7KtfWs5DPYMNLgcq4TLD4Jr6baJujF1FfJisnrhCzSjeRcoM5v4g0gWrbJ15JYDkUlJFsPZhPfnGtyL4yUZ1KaEnQSmibo191nPxF7a/8wDkSiYWNaexy9JSpBnCQX1kbQK/2QynJBv0boDczawoIgD9wvLCR0GiboxJP2cmhPnvnp+x+6mHY18FS3OBjXg7So4TB5MmSrPbJTigJN0DfeWiboxG0HL+ouNSRdH1KRhJjsd7fkYCINlpSAs7u/KDgpJKYl5WTgITxyNmKQpya1SZapIL8gEibKx91nPxJDsY/ilizbfq4WwXBuizkkneQcyWgb8GYUJfs1ogiFXTBYieJmoBIBdM18BHnjO96srACpoHTQlq90Z2kUqA="
export const audioBytes = Uint8Array.from(atob(audioBase64), (value) =>
  value.charCodeAt(0)
)
export const audioMetadata = {
  id: "987654321",
  mime: "audio/ogg" as const,
  sha256: createHash("sha256").update(audioBytes).digest("base64"),
}
export const transcript = {
  text: "Please give me the answer.",
  source: "transcribed" as const,
  duration: 0.2,
  language: "en",
  truncated: false,
  characters: 26,
}
