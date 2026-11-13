# VANZY Manager

VANZY A2向けの非公式・実験的なWindows設定ツールです。React / TypeScript / Tauri / Rustで実装しています。メーカーによる公式製品・サポートではありません。

## 対応と制限

- Windowsで既にペアリング済みのVANZY A2、ファームウェア3.2.1を対象とします。
- 機体固有の名前を固定せず、既知の名前形式 `VANZY#1-XXXX/A2`（XXXXは大文字16進数4桁）の機体を検出します。複数の候補がある場合は安全のため停止し、勝手に選びません。
- 他の機体・ファームウェアでの実機動作は未検証です。一般化した検出ロジックのテスト成功は、全VANZYの互換性を保証するものではありません。
- macOSの実機通信には対応していません。ブラウザ起動はデモです。
- 自動ペアリング、ファームウェア更新、他ホストからの接続奪取は行いません。

## 機能

- ジェスチャー割り当ての読取り、バックアップ、変更確認、書込み後の読戻し。
- キーと修飾キーの割り当て、ホスト側の複数キー同時入力。
- ホスト変換終了時の復元と、中断時の復旧確認。

入力送信は明示的に開始してください。管理者権限で動くアプリへの入力はWindowsの制約で届かない場合があります。自動昇格は行いません。復元が確認できないときは再試行を繰り返さず、接続状態とバックアップを確認してください。

## 開発

Node.js 22.12以上、Rust stable、WindowsのTauri 2ビルド前提（MSVC C++ Build Tools / WebView2）が必要です。

```sh
npm ci
npm run dev
npm test
npm run test:native-contract
npm run build
cargo test --manifest-path src-tauri/safety-core/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build
```

`npm run dev` はブラウザのデモ、`npm run tauri dev` はネイティブ版を起動します。ネイティブ版での操作は実機設定を変更するため、まず読取りとバックアップを行ってください。

## 秘密情報の混入防止

Betterleaksの公式リリース **v1.10.1** と `pre-commit` をインストールし、両方をPATHから呼び出せる状態にしてください。公式フックはコミットSHAで固定しています。

```sh
pre-commit install
pre-commit run --all-files
betterleaks dir . --redact --no-banner
betterleaks git . --redact --no-banner
```

フックはステージされた差分を検査します。上の `dir` 検査が現在のファイル、`git` 検査がコミット履歴を対象とします。検出を無効化してコミットしないでください。秘密情報の検出と、個人情報・ライセンスの目視確認は別です。

## 公開範囲

ソースとテストだけを公開しています。個人の実機ログ、端末バックアップ、自宅環境の配置情報、開発用の会話設定、メーカーのAPK・ファームウェア・逆アセンブル抜粋、生成済みバイナリは含めていません。

依存ライブラリの表記は [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt) を参照してください。このプロジェクト自体のOSSライセンスは未指定です。依存ライブラリのライセンスが本プロジェクト全体の利用許諾になるわけではありません。

