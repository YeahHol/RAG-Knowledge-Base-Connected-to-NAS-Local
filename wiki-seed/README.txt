LLM Wiki 整理层（与当前 RAG 结合）
================================

1. 在已配置的 NAS 扫描根目录下创建文件夹 wiki（名称须与 .env 中 WIKI_LAYER_PREFIXES 一致，默认即 wiki）。

2. 将本目录中除 README.txt 外的 .md 文件复制到 NAS 的 wiki/ 下（可按需增删主题子目录 topics/）。

3. 在「文件管理」中对 wiki 目录或整库执行「重建索引」，使整理层页面进入向量与关键词检索。

4. 之后维护流程建议：
   - 原文 PDF/合同仍放在资料库其它路径；
   - 结论、口径、跨文档对照写在 wiki/topics/*.md；
   - changelog.md 记录合并来源与修订原因。

可调环境变量（可选）：
  WIKI_LAYER_ENABLED=true|false
  WIKI_LAYER_PREFIXES=wiki          （多个用逗号，如 wiki,知识整理）
  WIKI_LAYER_SCORE_BONUS=32           （检索加分，0～160）
  WIKI_MAX_CHUNKS_PER_FILE=4          （单文件进入 Top 结果条数上限，整理层可略高于 SEARCH_MAX_CHUNKS_PER_FILE）
