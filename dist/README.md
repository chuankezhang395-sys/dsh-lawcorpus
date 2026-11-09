# 独立 law-paper-writing 安装包

下载本目录的 `skill.zip`，在 GitHub 文件页选择 Download raw file（下载原始文件）。不要下载仓库源码 ZIP 代替技能安装包。将 `skill.zip` 完整上传至账号提供的 ChatGPT Skills 自定义技能入口；需要支持 Python 执行和技能文件访问的会话。尚未实际在 ChatGPT 网页完成上传验证。

包内仅一个 `law-paper-writing/` 目录，17个文件：一个 SKILL.md、一个 Python 检索脚本、agents/openai.yaml、中文 README、代码 LICENSE 和12个原始 JSONL。以合并至 main 的 Python Skill 为基础，不含原 DSH Skill 或项目运行依赖。脚本以自身位置的上一级作为技能根目录，默认读取内部 data/，不依赖仓库路径。

验证结果见 `validation.json`：9项现有回归测试全部通过；另在仓库外解压、从无关工作目录通过 CLI 验证统计、检索、期刊分析、框架、词面比较及 Markdown/CSV/JSONL 导出，并完成全部850条记录的 JSONL 导出往返比对。原始与包内12个语料文件的 SHA-256 均一致。850条中有847篇标准论文、3条笔谈/编者按。

题录只读，未补造任何文献信息。题录并非全文，原始 PDF 未附带；保留原抽取缺陷与语料覆盖限制。LICENSE 不替代论文作者或出版方对内容的权利授权。
