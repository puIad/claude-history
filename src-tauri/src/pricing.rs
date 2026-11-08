//! Per-model token prices (USD per million tokens) and context windows.
//! Cache writes cost 1.25x input for the 5-minute TTL and 2x input for 1 hour.

#[derive(Clone, Copy, Debug)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
}

fn base(model: &str) -> String {
    let m = model.to_ascii_lowercase();
    let m = m.split('[').next().unwrap_or("").to_string(); // drop "[1m]"
    m.trim().to_string()
}

pub fn price(model: &str) -> Option<Price> {
    let m = base(model);
    let p = |input: f64, output: f64, cache_read: f64| Some(Price { input, output, cache_read });
    if m.contains("fable-5-1") || m.contains("mythos-5-1") {
        return p(10.0, 50.0, 0.25);
    }
    if m.contains("fable-5") || m.contains("mythos-5") || m.contains("mythos") {
        return p(10.0, 50.0, 1.0);
    }
    if m.contains("opus-5-5") {
        return p(4.0, 20.0, 0.20);
    }
    if m.contains("opus-5") {
        return p(5.0, 25.0, 0.50);
    }
    if m.contains("opus-4-8") || m.contains("opus-4-7") || m.contains("opus-4-6") || m.contains("opus-4-5") {
        return p(5.0, 25.0, 0.50);
    }
    if m.contains("opus") {
        return p(15.0, 75.0, 1.50);
    }
    if m.contains("sonnet-5") {
        return p(2.0, 10.0, 0.20);
    }
    if m.contains("sonnet") {
        return p(3.0, 15.0, 0.30);
    }
    if m.contains("haiku-5") {
        return p(0.10, 0.50, 0.01);
    }
    if m.contains("haiku-4") {
        return p(1.0, 5.0, 0.10);
    }
    if m.contains("haiku") {
        return p(0.80, 4.0, 0.08);
    }
    None
}

pub struct UsageTokens {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write_5m: u64,
    pub cache_write_1h: u64,
    pub fast: bool,
}

pub fn cost(model: &str, u: &UsageTokens) -> f64 {
    let Some(p) = price(model) else { return 0.0 };
    let mult = if u.fast { 2.0 } else { 1.0 };
    let mt = 1_000_000.0;
    mult * (u.input as f64 * p.input / mt
        + u.output as f64 * p.output / mt
        + u.cache_read as f64 * p.cache_read / mt
        + u.cache_write_5m as f64 * p.input * 1.25 / mt
        + u.cache_write_1h as f64 * p.input * 2.0 / mt)
}

pub fn context_window(model: &str) -> u64 {
    let raw = model.to_ascii_lowercase();
    if raw.contains("[1m]") {
        return 1_000_000;
    }
    let m = base(model);
    let one_m = ["fable", "mythos", "opus-5", "opus-4-8", "opus-4-7", "opus-4-6", "sonnet-5", "sonnet-4-6", "haiku-5"];
    if one_m.iter().any(|k| m.contains(k)) {
        1_000_000
    } else {
        200_000
    }
}

/// "claude-opus-5-5" -> "Opus 5.5", "claude-sonnet-4-5-20250929" -> "Sonnet 4.5".
pub fn display_name(model: &str) -> String {
    let m = base(model);
    let m = m.strip_prefix("claude-").unwrap_or(&m);
    let mut parts = m.split('-');
    let Some(family) = parts.next() else { return model.to_string() };
    let mut nums: Vec<&str> = Vec::new();
    for p in parts {
        if p.len() <= 2 && p.chars().all(|c| c.is_ascii_digit()) {
            nums.push(p);
        } else {
            break;
        }
    }
    let mut fam = family.to_string();
    if let Some(f) = fam.get_mut(0..1) {
        f.make_ascii_uppercase();
    }
    if nums.is_empty() {
        fam
    } else {
        format!("{} {}", fam, nums.join("."))
    }
}
