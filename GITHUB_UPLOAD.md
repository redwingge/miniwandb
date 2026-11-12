# 上传源码到 GitHub

仓库根目录应包含 `pyproject.toml`、`README.md`、`TRAINING_GUIDE.md`、`AI_ANALYSIS_GUIDE.md`、`miniwandb/`、`examples/`、`tests/` 和 `skills/`。这些文件足够安装、运行和开发 MiniWandb。

实验数据库、W&B 原始日志、模型权重、数据集、虚拟环境和构建缓存不属于源码。`.gitignore` 已提供常见排除规则；提交前请查看暂存文件列表。

## 安装与验证

在此目录运行：

```bash
python -m pip install -e .
python -m unittest discover -s tests -v
python -m miniwandb demo --dir ./demo_runs
python -m miniwandb serve --dir ./demo_runs --port 8080
```

前端测试见 README 的开发验证部分，使用 Node.js，无需 npm 依赖。示例产生的数据库保持在本地。

## 创建仓库并推送

在 GitHub 创建空仓库后，按实际仓库地址执行：

```bash
git init
git add .
git diff --cached --stat
git commit -m "Initial MiniWandb source"
git branch -M main
git remote add origin https://github.com/YOUR_NAME/YOUR_REPOSITORY.git
git push -u origin main
```

如果需要开源许可证，请选择适合项目的许可证并添加 `LICENSE`；本项目源码整理不会代替作者作出授权决定。
