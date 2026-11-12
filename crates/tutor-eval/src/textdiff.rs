//! Line-level diff for the localized-edit review (prompt §2: "show what changes").
//!
//! Classifies every line of the proposed block against the original as context / added /
//! removed, via a standard LCS. This is the structured basis the UI needs to highlight the
//! change and to let the developer accept only the lines they selected.

use serde::Serialize;

/// What happened to a line going from the original block to the proposed one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Op {
    /// Unchanged — present in both.
    Context,
    /// Added — only in the proposal.
    Add,
    /// Removed — only in the original.
    Del,
}

/// One line of the diff.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub op: Op,
    pub text: String,
}

/// Line-level diff of `old` → `new` (LCS). The sequence reads top-to-bottom: context lines
/// are shared, dels are old-only, adds are new-only. A replaced line shows as a del followed
/// by an add.
pub fn line_diff(old: &str, new: &str) -> Vec<DiffLine> {
    let a: Vec<&str> = old.lines().collect();
    let b: Vec<&str> = new.lines().collect();
    let (n, m) = (a.len(), b.len());

    // dp[i][j] = LCS length of a[i..] and b[j..].
    let mut dp = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if a[i] == b[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }

    let mut out = Vec::new();
    let (mut i, mut j) = (0, 0);
    let line = |op, s: &str| DiffLine { op, text: s.to_string() };
    while i < n && j < m {
        if a[i] == b[j] {
            out.push(line(Op::Context, a[i]));
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            out.push(line(Op::Del, a[i]));
            i += 1;
        } else {
            out.push(line(Op::Add, b[j]));
            j += 1;
        }
    }
    while i < n {
        out.push(line(Op::Del, a[i]));
        i += 1;
    }
    while j < m {
        out.push(line(Op::Add, b[j]));
        j += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ops(d: &[DiffLine]) -> Vec<(Op, &str)> {
        d.iter().map(|l| (l.op, l.text.as_str())).collect()
    }

    #[test]
    fn unchanged_is_all_context() {
        let d = line_diff("a\nb\nc", "a\nb\nc");
        assert!(d.iter().all(|l| l.op == Op::Context));
        assert_eq!(d.len(), 3);
    }

    #[test]
    fn pure_add_and_del() {
        let added = line_diff("a\nc", "a\nb\nc");
        assert_eq!(ops(&added), vec![(Op::Context, "a"), (Op::Add, "b"), (Op::Context, "c")]);
        let removed = line_diff("a\nb\nc", "a\nc");
        assert_eq!(ops(&removed), vec![(Op::Context, "a"), (Op::Del, "b"), (Op::Context, "c")]);
    }

    #[test]
    fn replace_is_del_then_add() {
        let d = line_diff("a\nold\nc", "a\nnew\nc");
        assert_eq!(ops(&d), vec![(Op::Context, "a"), (Op::Del, "old"), (Op::Add, "new"), (Op::Context, "c")]);
    }

    #[test]
    fn from_empty_is_all_add() {
        let d = line_diff("", "x\ny");
        assert!(d.iter().all(|l| l.op == Op::Add));
        assert_eq!(d.len(), 2);
    }
}
