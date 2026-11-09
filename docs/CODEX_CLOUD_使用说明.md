# 在网页版 Codex Cloud 使用法学论文语料库

## 你只需要这样说

把这个仓库连接到 Codex Cloud，打开以该仓库为工作区的任务。Skill 文件位于 `.agents/skills/law-paper-writing/SKILL.md`，供 Codex 发现。新建任务后可以直接说：

> 使用 law-paper-writing，检索“离婚后未成年子女抚养费”。先告诉我有没有直接命中，再找相邻主题，给我3张真实框架卡，附作者、刊名、年期和来源。不要编造文献。

也可以说：

- “分析《法学研究》2024—2026年本库论文的关键词和结构特点。”
- “我拟研究……，请用我的标题和摘要对标本库论文，说明词面相近之处。”
- “把这次检索结果导出为 Markdown、CSV 和 JSONL，放在 output 文件夹。”

如果当前会话没有发现新 Skill，请让 Codex 直接读取上述 SKILL.md 并运行其中的 Python 脚本，或新开一个仓库任务。若修改保存在PR分支且尚未合并，新任务请在你自己的仓库选择 `codex/python-law-paper-skill` 分支，确保能读取新Skill；主分支在合并前仍是旧版本。

## 已有数据与核验边界

已实际读取12个JSONL文件：850条题录（847篇标准论文、3条笔谈/编者按），四刊为中国法学、比较法研究、法学研究、中外法学，年份2024—2026。原始文件全部保留，没有改写或补造题录。代码许可证保留MIT；论文内容的使用仍需尊重原作者及出版方权利，MIT文件不能代替论文权利授权。

摘要、关键词、目录均为题录字段，不含全文。所有标准论文三个字段均非空，但不代表内容准确或出版真实性已核实。仓库没有原始PDF或出版方核验材料，不能逐篇核验。发现例如ID `7e581ab4794a` 的原题名为“7条之适用”，疑似截断；工具保留原记录，status列出短题名供人工复核。source如 `pdf:zgfx2024.txt` 是原抽取记录，不是可下载链接。

原说明记载：中外法学2024缺第1、2、5期；2026非全年完整；部分期号为规则回填。以上缺期情况来自旧说明，未凭PDF独立复核。

## 功能与命令（供 Codex 自动执行）

需要 Python 3.10 或更新版本；无需 pip install、Node.js、DeepSeek Harness、API Key 或联网。以下在仓库根目录运行：

```bash
python3 .agents/skills/law-paper-writing/scripts/lawcorpus.py status
python3 .agents/skills/law-paper-writing/scripts/lawcorpus.py search --query "离婚后未成年子女抚养费" --limit 5
python3 .agents/skills/law-paper-writing/scripts/lawcorpus.py search --query "抚养费" --mode phrase
python3 .agents/skills/law-paper-writing/scripts/lawcorpus.py search --query "离婚 子女" --mode all
python3 .agents/skills/law-paper-writing/scripts/lawcorpus.py frame --query "亲属扶养" --limit 3
python3 .agents/skills/law-paper-writing/scripts/lawcorpus.py profile --journal "法学研究" --year-from 2024 --year-to 2026
python3 .agents/skills/law-paper-writing/scripts/lawcorpus.py match --title "离婚后未成年子女抚养费" --keywords "离婚；子女；抚养费"
python3 .agents/skills/law-paper-writing/scripts/lawcorpus.py export --query "亲属扶养" --mode phrase --format markdown --output output/亲属扶养.md
python3 .agents/skills/law-paper-writing/scripts/lawcorpus.py export --query "亲属扶养" --mode phrase --format csv --output output/亲属扶养.csv
python3 .agents/skills/law-paper-writing/scripts/lawcorpus.py export --query "亲属扶养" --mode phrase --format jsonl --output output/亲属扶养.jsonl
python3 -m unittest discover -s test -p 'test_python*.py' -v
```

- `status`：总数、各刊各年、类型、字段非空数、短题名线索、全部输入文件SHA-256。
- `search`：题名权重3、关键词4、摘要1、目录1的分字段BM25；连续汉字双字切分，英文数字整词。不是向量语义检索。单字不支持。不自动扩展近义词。
- `frame`：原始目录、原始摘要与按词表挑出的“问题/方法/结论”原句。无法识别时为null，不用通用模板填充。
- `profile`：当前筛选样本的关键词频次、摘要长度、目录条数、规则体裁与标题句式；不是官方分类或投稿指南。
- `match`：将你提供的标题、摘要、关键词与本库比较，给词元覆盖率、摘要长度差和关键词交集；不判断质量、创新性或录用率。至少提供其中一项。
- `export`：JSONL完整保留原记录所有字段；CSV数组用JSON表示、加UTF-8 BOM便于Excel打开，并对公式前缀做防护；Markdown包含摘要、目录及文件行号。空命中也可导出空文件/表头，不回退为全库。

所有命令输出UTF-8 JSON，出错时以退出码2和中文错误提示结束，不静默跳过损坏行或覆盖重复ID。

通用筛选包括 `--journal`、`--year-from`、`--year-to`、`--type`、`--genre`。status/export默认全部类型，其他命令默认标准论文。无效刊名返回0条，不替用户扩大范围。体裁为新Python简化规则，与旧JS的具体分类或排名不保证一致。

默认ranked模式允许部分词元命中，可能只含“未成年”而完全不谈抚养费。`coverage`仅为不同查询词元的命中比例。`exact_phrase_fields`列出完整短语出现的字段；`--mode phrase`要求完整短语出现；`--mode all`要求空格分隔的每个词均出现。三种模式仍需阅读上下文判断相关性。`--limit`只限制search/frame/match显示数量，profile统计和export输出所有筛选命中；`matched_total`是截断前总数。

可以在子命令前加 `--data-dir 路径` 或设置 `LAWCORPUS_DIR` 指定另一个同格式题录目录；否则总是按脚本位置定位仓库data。自定义目录必须提供id/title/journal/year等正确字段，重复ID会报错。不要单独搬走Skill目录而遗漏data；如需搬运，带上整个仓库或指定真实语料目录。

导出只能写当前工作目录下的 `output/`，不能通过符号链接写出，不能覆盖语料；已有文件默认拒绝覆盖。明确需要替换导出文件时加 `--overwrite`。日常查询不会运行旧tools建库脚本；那些脚本可能覆盖data，扩展语料前应备份并另行核验。

## “离婚后未成年子女抚养费”的测试结论

现有题录的题名、摘要、关键词、目录中，“离婚后未成年子女抚养费”“抚养费”“抚养”的完整短语命中均为0。“离婚”命中4条，“子女”4条，“未成年”11条；这些是题录字段的命中数，不是全文出现次数。

“亲属扶养”可命中夏江皓《亲属扶养的理论构造及规范展开》，中国法学2026年第5期，ID `e966d02dc1e7`。这是相邻主题，不可直接宣称它专门研究“离婚后未成年子女抚养费”。“扶养”和“抚养”保留原字，不互相替换。具体测试过程与结果见 `docs/测试报告.md`。

## 原版兼容

旧 `lib/`、`skill/`、`tools/`、package.json和DeepSeek Harness用法保留。新Skill在 `.agents/skills/`，不依赖旧插件注册工具。此次没有重新建库、抓取论文或补写缺失字段。
