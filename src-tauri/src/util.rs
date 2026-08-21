use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let bits = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        output.push(ALPHABET[((bits >> 18) & 63) as usize] as char);
        output.push(ALPHABET[((bits >> 12) & 63) as usize] as char);
        output.push(if chunk.len() > 1 {
            ALPHABET[((bits >> 6) & 63) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            ALPHABET[(bits & 63) as usize] as char
        } else {
            '='
        });
    }
    output
}

pub(crate) fn base64_url_encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}
pub(crate) fn base64_decode(text: &str) -> Result<Vec<u8>, String> {
    fn value(byte: u8) -> Result<u32, String> {
        match byte {
            b'A'..=b'Z' => Ok(u32::from(byte - b'A')),
            b'a'..=b'z' => Ok(u32::from(byte - b'a') + 26),
            b'0'..=b'9' => Ok(u32::from(byte - b'0') + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err("无效的 base64 内容".to_owned()),
        }
    }
    let bytes = text.as_bytes();
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    if !bytes.chunks_exact(4).remainder().is_empty() {
        return Err("无效的 base64 长度".into());
    }
    let mut output = Vec::with_capacity(bytes.len() / 4 * 3);
    let chunk_count = bytes.len() / 4;
    for (chunk_index, chunk) in bytes.chunks(4).enumerate() {
        let pad = chunk.iter().rev().take_while(|&&byte| byte == b'=').count();
        if pad > 2 || (pad > 0 && chunk_index + 1 != chunk_count) {
            return Err("无效的 base64 填充".into());
        }
        if (pad == 2 && value(chunk[1])? & 0x0f != 0) || (pad == 1 && value(chunk[2])? & 0x03 != 0)
        {
            return Err("base64 内容不是规范编码".into());
        }
        let mut bits = 0u32;
        for (index, &byte) in chunk.iter().enumerate() {
            let digit = if index >= 4 - pad { 0 } else { value(byte)? };
            bits = (bits << 6) | digit;
        }
        output.push((bits >> 16) as u8);
        if pad < 2 {
            output.push((bits >> 8) as u8);
        }
        if pad < 1 {
            output.push(bits as u8);
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip() {
        // Every residue class plus non-UTF8 bytes (the upload path carries binaries).
        let mut data: Vec<u8> = (0u16..=255).map(|b| b as u8).collect();
        for len in [0usize, 1, 2, 3, 4, 255, 256] {
            let slice = &data[..len];
            assert_eq!(
                base64_decode(&base64_encode(slice)).unwrap(),
                slice,
                "len={len}"
            );
        }
        data.extend([0, 159, 146, 150]); // invalid UTF-8 must survive
        assert_eq!(base64_decode(&base64_encode(&data)).unwrap(), data);
        assert!(base64_decode("abc").is_err());
        assert!(base64_decode("!!!!").is_err());
    }
}
