# 上位机发布说明

## 仓库与部署

- 上位机独立远程仓库：https://github.com/createskyblue/ch58x-th-plot.git
- 发布分支：main。
- GitHub Pages 站点：https://ch58x-th-plot.cacherivulet.cn/
- 本目录 web/ 的内容对应独立仓库的根目录，不要把整个固件工程或 web/ 这一层目录推过去。
- 父级固件工程与上位机远程仓库历史独立；不要直接在父级工程执行 git push main，也不要强制推送或合并两段历史。

## 推送流程

1. 在本目录检查 git diff，并只提交本次上位机相关文件，避免提交父级目录的无关改动。
2. 在一个新的临时目录克隆独立仓库：

   git clone https://github.com/createskyblue/ch58x-th-plot.git <临时目录>

3. 将本次修改的上位机文件复制到克隆目录的对应根目录路径；新增文件同样复制，明确删除的文件使用 git rm。保留远程仓库其他文件，不要用整目录镜像删除远程内容。
4. 本 AGENTS.md 也发布到独立仓库根目录。若直接在独立仓库工作，则跳过克隆和复制，拉取最新 main 后正常提交。
5. 在克隆目录检查 git status、git diff --stat 和 git diff --check，验证浏览器模块及 HTML 内联脚本语法，针对行为变更执行验证。
6. 使用 git add 显式添加本次文件，git commit 后执行 git push origin main。如果远程有新提交，先拉取并处理差异，不要 force push。
7. 用 git ls-remote origin refs/heads/main 核对远程提交。推送成功不等于 Pages 已部署；如未验证线上效果，应明确说明。

## 发布注意

- 浏览器模块使用 .js，import 与 script 引用必须同步；本项目曾出现 .mjs 被服务器作为 application/octet-stream 返回、导致模块无法加载的问题。
- 默认壁纸资源为 assets/default-wallpaper.png，确保一同发布。
- 页面固定输出 400×300。原图与黑白预览共用手势逻辑，修改时同时检查手机拖动、双指缩放及页面滚动行为。
- 历史导入逻辑同时存在于 index.html 内联代码与 history-import.js，修改时保持一致。
- 未经用户明确允许，不关闭任何页面、标签页或应用窗口。
