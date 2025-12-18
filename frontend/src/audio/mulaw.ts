// μ-law codec (G.711) for 16-bit PCM <-> 8-bit mu-law
// Reference behavior compatible with Twilio Media Streams (8kHz, mono, mulaw).

const BIAS = 0x84; // 132
const CLIP = 32635;

export function linear16ToMuLawSample(sample: number): number {
  // sample: int16 [-32768..32767]
  let sign = 0;
  let pcm = sample;
  if (pcm < 0) {
    sign = 0x80;
    pcm = -pcm;
    if (pcm < 0) pcm = 32767; // handle -32768
  }
  if (pcm > CLIP) pcm = CLIP;
  pcm = pcm + BIAS;

  // Determine exponent and mantissa
  let exponent = 7;
  for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  const muLaw = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return muLaw;
}

export function muLawToLinear16Sample(muLawByte: number): number {
  let u = (~muLawByte) & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let pcm = ((mantissa << 3) + BIAS) << exponent;
  pcm -= BIAS;
  return sign ? -pcm : pcm;
}

export function pcm16ToMuLaw(pcm16: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    out[i] = linear16ToMuLawSample(pcm16[i]);
  }
  return out;
}

export function muLawToPcm16(mulaw: Uint8Array): Int16Array {
  const out = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) {
    out[i] = muLawToLinear16Sample(mulaw[i]);
  }
  return out;
}






