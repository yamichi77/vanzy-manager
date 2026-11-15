# VANZY Manager

VANZY 3.0向けの非公式・実験的なWindows / macOS設定ツールです。キー割り当ての読取り・バックアップ・変更と、PC側で実行するマクロに対応しています。メーカーの公式サポートはありません。

## 対応環境

- VANZY 3.0 / FW 3.2.1が対象です。Windowsではペアリング済み、macOSでは接続中の機体が1台必要です。
- MacではBluetoothと、キー送信用のアクセシビリティ許可を本人が行います。自動ペアリングやファームウェア更新は行いません。
- Macの読取り・保存・復元は限定的に実機確認済みです。Windowsの最新変更後の実機回帰、マクロの実キー到達・URL遷移、他機体・FW、切断からの復帰は未検証です。

## 使い方

1. 「本体を読み取る」で現在の設定を読み、変更前にバックアップします。
2. 割り当てを編集し、保存後に読戻しで確認します。マクロの「PC内に保存」は本体の割り当てを書き換えません。
3. PCからキーを送るときだけ「送信を開始」を押し、終了時は停止して復元を確認します。復元を確認できなければ再試行を繰り返さず、接続とバックアップを確認してください。

マクロにはキー入力・待機・アプリ起動・URLを開く操作を並べられます。送信先アプリの最前面条件は任意です。最前面の確認や待機だけでは入力欄・マイクの準備完了は分かりません。URLに認証情報を入れないでください。権限昇格やOSのフォーカス制限の回避は行いません。

## 開発・ビルド

Node.js 22.12以上、Rust stable、Tauri 2の開発環境が必要です。WindowsはMSVC C++ Build ToolsとWebView2、MacはXcode Command Line Toolsを用意します。

```sh
npm ci
npm run tauri dev
npm test
```

`npm run dev` は実機に接続しないブラウザのデモです。

### Windows

PowerShellで実行します。出力先は `src-tauri/target/release/vanzy-manager.exe` です。

```powershell
.\node_modules\.bin\tauri.cmd build --no-bundle
```

`cargo build --release` だけの成果物は配布しないでください。`custom-protocol` がないと画面が空白になることがあります。

### macOS

`npm run tauri build -- --bundles app` でBLEヘルパー込みのアプリを作ります。更新時は同じ署名主体・バンドル識別子を維持し、通常更新にはad-hoc署名を使わないでください。署名方式を変えると本人による権限の再承認が必要になる場合があります。

署名には [ローカル署名スクリプト](scripts/sign-macos-local.mjs)、更新前の確認には `npm run check:mac-signing -- "src-tauri/target/release/bundle/macos/VANZY Manager.app" "$HOME/Applications/VANZY Manager.app"` を使えます。自己署名は他の人への配布用ではありません。外部配布にはDeveloper ID署名と公証を使います。

## 公開時の注意

秘密鍵・ローカル設定・実機ログ・バックアップ・生成済みバイナリはコミットしないでください。Betterleaks v1.10.1とpre-commitを用意し、`pre-commit install` / `pre-commit run --all-files` で検査します。検出を無効化してコミットしないでください。

依存ライブラリの表記は [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt) を参照してください。本プロジェクト自体のOSSライセンスは未指定です。依存ライブラリのライセンスは本プロジェクト全体の利用許諾ではありません。
