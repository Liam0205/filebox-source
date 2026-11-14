// 虚拟路径。GitHub 会把资源名里的斜杠、中文、空格统统改写，所以路径
// 只存在于我们自己的 KV 索引里，GitHub 上看到的是不透明 id。
//
// 路径形如 photos/2026/a.jpg。规则：
//   - 用 / 分段，不以 / 开头或结尾，不出现空段
//   - 每段不是 "." 或 ".."，不含控制字符和反斜杠
//   - 总长和段数都有上限，避免 KV 键和 URL 过长

const SEGMENT_RE = /^[^\u0000-\u001f\u007f/\\]+$/;
const MAX_SEGMENT = 120;

export function isPathSegments(path, cfg) {
  if (typeof path !== "string" || path === "") return false;
  if (path.length > cfg.maxPathLength) return false;
  const segs = path.split("/");
  if (segs.length > cfg.maxPathSegments) return false;
  for (const seg of segs) {
    if (!seg || seg === "." || seg === "..") return false;
    if (seg.length > MAX_SEGMENT) return false;
    if (!SEGMENT_RE.test(seg)) return false;
    if (seg.trim() !== seg) return false;
  }
  return true;
}

export function segments(path) {
  return path.split("/");
}

export function dirname(path) {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function basename(path) {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

// 文件是否直接或间接位于 dir 之下（dir 为空表示根目录）。
export function isUnder(path, dir) {
  if (!dir) return true;
  return path.startsWith(`${dir}/`);
}

// 路径 → URL 片段，逐段编码，斜杠保持为分隔符。
export function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

// 浏览器上传的 File.name 可能带有路径分隔符或控制字符，这里清洗掉。
export function sanitizeFileName(name) {
  let s = String(name || "")
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    .trim();
  if (s === "" || s === "." || s === "..") s = "file";
  if (s.length > MAX_SEGMENT) s = s.slice(0, MAX_SEGMENT);
  return s;
}

export function extOf(name) {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

export function extAllowed(name, allowed) {
  if (!allowed || allowed.length === 0) return true;
  return allowed.includes(extOf(name));
}
