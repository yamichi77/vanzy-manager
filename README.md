# VANZY Manager

VANZY A2向けの非公式・実験的なWindows / macOS設定ツールです。React / TypeScript / Tauri / Rustで実装しています。メーカーによる公式製品・サポートではありません。

## 対応と制限

- Windowsで既にペアリング済みのVANZY A2、ファームウェア3.2.1を対象とします。
- 機体固有の名前を固定せず、既知の名前形式 `VANZY#1-XXXX/A2`（XXXXは大文字16進数4桁）の機体を検出します。複数の候補がある場合は安全のため停止し、勝手に選びません。
- 他の機体・ファームウェアでの実機動作は未検証です。一般化した検出ロジックのテスト成功は、全VANZYの互換性を保証するものではありません。
- macOS版はCoreBluetoothによる実機通信とホスト入力を実装しています。対象はmacOSで既に接続中のVANZY A2 / FW 3.2.1が1台ある場合です（ペアリング済みでも未接続の機体は列挙しません）。実機で確認した範囲と未検証事項は下記を参照してください。ブラウザ起動はデモです。
- macOSではBluetoothの許可、ホスト入力を使う場合はアクセシビリティの許可が必要です。アプリがこれらの権限を自動で許可することはありません。
- 自動ペアリング、ファームウェア更新、他ホストからの接続奪取は行いません。

## 実機確認の範囲

macOS の VANZY A2 / FW 3.2.1 を対象とした限定的な実機検証で、以下を確認しています。他の環境への互換性保証ではありません。

- 本体設定11項目の読取りとバックアップ、単キー割り当ての保存・読戻し。
- アプリ用の複数キー割り当ての登録と、ジェスチャー受信および利用者による入力到達報告。ただし、入力一致履歴による全送信イベントの個別検証は未実施です。
- 試行の停止・復元完了表示と、停止後の本体設定11項目が直近の保存原本と一致すること。本体の保存設定とアプリ用の割り当てが保持されること。
- 初回に利用者が許可した後、同一のローカル自己署名証明書と bundle identifier を使った複数ビルドの更新・アプリ再起動で、アクセシビリティ許可が維持されること。限定的な検証結果であり、他の Mac・OS バージョンや異なる署名への移行を保証しません。

今回の macOS 対応・共通 UI 修正後の Windows 実機回帰試験は未実施です。自動テストの成功はその代替にはなりません。他の機体・ファームウェア、スリープや Bluetooth 切断からの復帰、すべての入力先アプリでの動作も未検証です。

## 機能

- ジェスチャー割り当ての読取り、バックアップ、変更確認、書込み後の読戻し。
- キーと修飾キーの割り当て、ホスト側の複数キー同時入力。
- ホスト変換終了時の復元と、中断時の復旧確認。

入力送信は明示的に開始してください。管理者権限で動くアプリへの入力はWindowsの制約で届かない場合があります。自動昇格は行いません。復元が確認できないときは再試行を繰り返さず、接続状態とバックアップを確認してください。

## 開発

Node.js 22.12以上、Rust stable、各OSのTauri 2ビルド前提（Windows: MSVC C++ Build Tools / WebView2、macOS: Xcode Command Line Tools）が必要です。

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


## macOS ローカルビルド

`npm run tauri build -- --bundles app` でSwiftの固定BLEヘルパーもコンパイル・同梱します。実機権限を維持する更新には、同じ署名主体・bundle identifier を維持できる永続的なコード署名 identity を使ってください。ローカル開発では Apple Development、外部配布では Developer ID 署名と公証を使います。署名方式の切替は権限の再承認が必要になることがあります。

`codesign --sign -` の ad-hoc 署名は各ビルドのハッシュを識別子とするため、アプリ更新で既存のプライバシー許可が一致しなくなります。許可一覧がオンでも、現ビルドが未許可になる場合があります。権限を確認する本体プロセスを再ビルドしても、この不一致は解消しません。通常更新に ad-hoc 署名を使わないでください。

配置前に読み取り専用のチェックを実行します（署名の作成・アプリ配置・権限変更は行いません）。ad-hoc 署名と、既存アプリと互換でない署名要件は拒否します。

```sh
npm run check:mac-signing -- "src-tauri/target/release/bundle/macos/VANZY Manager.app" "$HOME/Applications/VANZY Manager.app"
```

初回の署名方式移行では互換性チェックが失敗し得ます。無視して繰り返し更新するのではなく、署名方式を確定してから、利用者本人が macOS 標準 UI で旧項目の削除・現アプリの再追加と許可を行い、アプリ内で再確認してください。スイッチの切替だけでは古い署名要件が残ることがあります。TCC DB の書換え、権限の自動許可、署名要件の緩和は行いません。

参考: [Apple TN3127: Inside Code Signing: Requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements/)

起動時には機器へアクセスしません。「本体を読み取る」を明示的に実行した際に、未許可ならmacOSのBluetooth確認が表示されます。ホストキー送信はアクセシビリティ許可を非表示で確認し、未許可なら機器設定の一時変更より前に停止します。許可は本人がシステム設定で行ってください。キーは物理ANSI/ISO配置の対応表を使用し、PrintScreen等のMacに直接対応しないキーは拒否します。

オフライン検証は `src-tauri/binaries/vanzy-macos --self-test` および `src-tauri/binaries/vanzy-macos-host --self-test` で行えます。BLEやキー入力は実行しません。

### Macの権限確認

Windowsと共通の「本体を読み取る」「読み直す」を入口に、Macではキー送信用アクセシビリティの許可を確認し、未許可ならmacOS標準の案内を要求します。Bluetoothの許可は実際の読取り開始時にOSが確認します。最終的な許可は利用者本人が行います。アクセシビリティが未許可、または確認に失敗しても本体の読取りは続行します。

「送信を開始」ではアクセシビリティの許可を再確認し、未許可なら本体設定の一時変更やキー送信より前に停止します。許可後はもう一度「送信を開始」を押してください。起動時の許可要求、許可後の自動送信、独立した許可申請ボタンはありません。

#### この Mac だけで使う自己署名ビルド

秘密鍵はログインキーチェーンに置き、ソース・リポジトリ・配布物へ書き出しません。
各開発者は自分の署名鍵を用意してください。証明書の信頼設定や TCC をスクリプトから変更しません。

```sh
npm run tauri build -- --bundles app
export VANZY_SIGNING_IDENTITY='<自分のローカル署名証明書の SHA-1 指紋>'
node scripts/sign-macos-local.mjs \
  'src-tauri/target/release/bundle/macos/VANZY Manager.app' \
  "$HOME/Applications/VANZY Manager.app"
```

同じ署名証明書を継続使用し、更新前に両方の署名要件が一致するか確認します。
初回の ad-hoc 版からの移行では旧版との一致検証は失敗するのが正常です。
その場合だけ既存アプリをバックアップし、引数の既存版を省略して署名検証した候補へ置換します。
初回の OS 許可は本人が新しい署名版に対して行います。以後の許可保持は実機でも検証してください。
キーチェーンが署名鍵の使用確認を表示した場合は本人が認証してください。
自己署名は Developer ID 署名・公証ではなく、他の人向けバイナリ配布用ではありません。

### Host-only macros (experimental)

The native assignment screen retains the existing key editor. Selecting **マクロ**
opens an ordered step editor for that gesture: key tap/chord, bounded delay,
application launch/activation with a frontmost timeout, and URL opening in an
explicit application on macOS, or the registered OS URL handler on Windows. **PC内に保存** stores a separate local profile; it does not
write firmware or device mappings. Removing a macro restores the unchanged
original key assignment. During an explicitly started host session the macro
replaces that gesture's normal host output.

Macros run once, sequentially. Additional gestures while one runs are dropped,
not queued. Stop, disconnect, or a timeout cancels further steps without retry.
Key chords release their own keys before continuing. Each key step can optionally
require a specific application to be frontmost immediately before sending; a
mismatch stops the macro with a reason. Without that optional condition, a key
step sends normally to the current foreground app. Delays do not lock focus.
URL → delay → key sequences are supported, without a mandatory inherited target.
Application/URL opening still waits for its specified target with a bounded
timeout and rejects unexpected foreground transitions during that opening step.

Foreground verification does not prove content, text-field, or microphone
readiness, and delays are timing choices rather than readiness checks. Test key
steps require a preceding explicit application or URL opener; macro keys never
target VANZY Manager itself. No application-specific shortcuts or voice-input
behavior are built in.

The macOS adapter uses application bundle identifiers. The Windows adapter accepts
an absolute local EXE path (for example `C:\Program Files\Example\Example.exe`)
or a registered packaged app identifier prefixed with `aumid:` (for example
`aumid:Example.Package_abc!App`). These are identifiers, not command lines:
arguments, relative/UNC/device paths, and loose desktop AppUserModelIDs are not
accepted. Windows app opening restores an existing matching window when possible;
foreground activation remains subject to normal Windows restrictions and fails
safely if the target does not become frontmost. No elevation or focus workaround
is attempted. Paths are local to each PC; settings are not automatically portable.

Windows URL opening uses the OS-registered handler, not an arbitrary EXE argument.
The registered handler must match the configured application before dispatch;
unknown or mismatched handlers are refused. Afterwards the runner observes the
foreground application, not the destination page or input focus. This does not
establish that any particular ChatGPT, voice-input, or third-party app flow works.

Existing Windows single-chord behavior is unchanged. No shell/script steps,
loops, or built-in example URLs are provided. URLs and application identifiers
stay in local settings and are not included in runner error messages. Do not put
credentials in URLs.

### Windows standalone build

From the repository root in PowerShell, build with the Tauri CLI so the frontend
is built and embedded into the executable:

```powershell
.\node_modules\.bin\tauri.cmd build --no-bundle
```

The executable is `src-tauri/target/release/vanzy-manager.exe`. Do not distribute
an executable produced only by `cargo build --release`: without Tauri's
`custom-protocol` feature it can try the development URL instead of the embedded
frontend and show a blank window. Build output and local settings are not source
artifacts and must not be committed.

### Windows verification limits

The opening timeout includes the OS launch request and foreground wait. Cancellation stops later macro steps promptly. An already-dispatched OS request cannot be undone and may still finish; while it remains in flight, new macros are refused, never queued or replayed.

Executable identity comparison is case-insensitive for ASCII, not path canonicalization. Use the actual long executable path (not a short-name, junction alias or renamed copy). Packaged apps use `aumid:PackageFamily!ApplicationId`; hosted windows whose process does not expose that identity fail closed. These cases do not enable elevation or focus-policy bypasses.

Windows native verification on the main PC: release build and non-interactive unit/contract/UI tests completed. The opt-in neutral window probe was launched successfully, but did not become foreground within its deadline under the tool session; the sequence stopped before sending Tab/Space. Actual key delivery, packaged-app activation, and real URL navigation are therefore not claimed as verified. No ChatGPT, Grok, Muse, microphone or physical-device tests were performed.

The neutral, auto-closing probe source is `tests/native/WindowsMacroProbe.cs`. Compile it as `vanzy-macro-probe.exe` with the .NET Framework C# compiler and Windows Forms references. The ignored Rust test `macros::native_probe::isolated_windows_launch_and_key_delivery` requires `VANZY_MACRO_PROBE_EXE` and a fresh `VANZY_MACRO_PROBE_REPORT` path. It deliberately requires an interactive foreground; it never weakens Windows focus restrictions to make a test pass.
