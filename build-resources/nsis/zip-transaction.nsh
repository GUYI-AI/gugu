!ifndef BUILD_UNINSTALLER
Var guguStage
Var guguPowerShell
Var guguTransactionActive
Var guguTransactionResult
Var guguTransactionOutput
Var guguDiagnosticDir
Var guguLogHandle
Var guguLogSize
Var guguLogReady
Var guguFailureWasLock
Var guguFailureForeignTarget
Var guguFailureTitle
Var guguFailureMessage
Var guguFailureOutput
Var guguFailureShown

# The assisted installer's directory page normally appends APP_FILENAME when it
# is absent from the chosen path. Do not turn a registered custom installation
# into its own child directory when upgrading through the GUI.
!macro customSanitizeInstallDirectory
  Push $R0
  Push $R1
  ${If} $installMode == "all"
    ReadRegStr $R0 HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${Else}
    ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${EndIf}
  StrCpy $R1 "false"
  ${If} ${FileExists} "$INSTDIR.gugu-install-${APP_ID}\transaction.json"
    # A crash can leave only the journal and backup, even without registration.
    # Keep the chosen path; prepare validates ownership before recovery.
    StrCpy $R1 "true"
  ${ElseIf} $R0 == $INSTDIR
  ${AndIf} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    StrCpy $R1 "true"
  ${EndIf}
  ${If} $R1 != "true"
    ${StrContains} $R0 "${APP_FILENAME}" $INSTDIR
    ${If} $R0 == ""
      StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
    ${EndIf}
  ${EndIf}
  Pop $R1
  Pop $R0
!macroend

!macro guguTransaction PHASE
  WriteINIStr "$PLUGINSDIR\transaction-request.ini" "transaction" "Phase" "${PHASE}"
  FlushINI "$PLUGINSDIR\transaction-request.ini"
  Push "version=${VERSION} before phase=${PHASE} target=$INSTDIR"
  Call guguWriteLog
  nsExec::ExecToStack '"$guguPowerShell" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& ([ScriptBlock]::Create([IO.File]::ReadAllText($$env:GUGU_INSTALLER_ENTRY)))"'
  Pop $guguTransactionResult
  Pop $guguTransactionOutput
  Push "version=${VERSION} after phase=${PHASE} exit=$guguTransactionResult target=$INSTDIR"
  Call guguWriteLog
  ${If} $guguTransactionOutput != ""
    Push "$guguTransactionOutput"
    Call guguWriteLog
  ${EndIf}
!macroend

!macro customHeader
Function guguWriteLog
  Exch $R8
  StrCpy $guguLogReady "false"
  CreateDirectory "$guguDiagnosticDir"
  ClearErrors
  FileOpen $guguLogHandle "$guguDiagnosticDir\install.log" a
  ${IfNot} ${Errors}
    FileSeek $guguLogHandle 0 END $guguLogSize
    ${If} $guguLogSize == 0
      FileWriteWord $guguLogHandle 0xFEFF
    ${EndIf}
    FileWriteUTF16LE $guguLogHandle "$R8$\r$\n"
    ${IfNot} ${Errors}
      StrCpy $guguLogReady "true"
    ${EndIf}
    FileClose $guguLogHandle
  ${EndIf}
  Pop $R8
FunctionEnd

Function guguShowFailure
  ${If} $guguFailureShown == "true"
    Return
  ${EndIf}
  StrCpy $guguFailureShown "true"
  ${If} $LANGUAGE == 2052
    StrCpy $guguFailureTitle "安装未完成"
    ${If} $guguFailureWasLock == "true"
      StrCpy $guguFailureMessage "有程序正在使用咕咕的安装目录，请关闭后重试。日志：$guguDiagnosticDir"
    ${ElseIf} $guguFailureForeignTarget == "true"
      StrCpy $guguFailureMessage "所选文件夹包含无法识别为咕咕的文件，已保留。请重新运行安装器，选择新的空文件夹。目录：$INSTDIR。日志：$guguDiagnosticDir"
    ${Else}
      StrCpy $guguFailureMessage "请保留安装日志并联系支持。日志：$guguDiagnosticDir"
    ${EndIf}
  ${Else}
    StrCpy $guguFailureTitle "Installation could not be completed"
    ${If} $guguFailureWasLock == "true"
      StrCpy $guguFailureMessage "An application is using the installation folder. Close it and retry. Log: $guguDiagnosticDir"
    ${ElseIf} $guguFailureForeignTarget == "true"
      StrCpy $guguFailureMessage "This folder contains unrecognized files and was preserved. Run the installer again and choose a new empty folder. Folder: $INSTDIR. Log: $guguDiagnosticDir"
    ${Else}
      StrCpy $guguFailureMessage "Keep the installer log and contact support. Log: $guguDiagnosticDir"
    ${EndIf}
  ${EndIf}
  # Upstream hides the details button and suppresses normal file chatter. Keep
  # that default during a successful install, but expose the reason/log on failure.
  SetDetailsPrint both
  SetDetailsView show
  ${If} $guguFailureOutput != ""
    DetailPrint "$guguFailureOutput"
  ${EndIf}
  DetailPrint "$guguFailureMessage"
  !insertmacro MUI_HEADER_TEXT "$guguFailureTitle" "$guguFailureMessage"
  # NSIS replaces its page header after Abort and .onInstFailed runs when the
  # window closes. Show the actionable message now; a silent install never waits.
  MessageBox MB_OK|MB_ICONSTOP "$guguFailureTitle$\r$\n$\r$\n$guguFailureMessage" /SD IDOK
FunctionEnd

Function guguRollback
  ${If} $guguTransactionActive == "true"
    SetOutPath "$PLUGINSDIR"
    !insertmacro guguTransaction rollback
    StrCpy $guguTransactionActive "false"
  ${EndIf}
FunctionEnd

Function .onInstFailed
  Call guguRollback
  Call guguShowFailure
  SetErrorLevel 2
FunctionEnd

# @@@uac-outer-cwd - Under UAC an install for all users runs as two processes: the user's
# non-elevated installer waits while the elevated copy it started does the work. The waiting
# one inherits its working directory from whoever launched it, and the app's updater starts it
# from the app's own working directory, $INSTDIR. A directory being renamed cannot
# be anyone's working directory, so commit failed every time with "being used by another
# process" (measured: the only handle under the tree was the waiting installer's, access
# SYNCHRONIZE|FILE_TRAVERSE). The elevated copy asks it to step out first.
# The app now leaves $INSTDIR itself (@@@app-cwd), but an older app's updater or a double-click
# from inside $INSTDIR still starts this installer there, so the installer keeps its own step.
Function guguLeaveInstallDirectory
  SetOutPath "$TEMP"
FunctionEnd
!macroend

!macro guguRequireTransactionSuccess
  ${If} $guguTransactionResult != "0"
    StrCpy $guguFailureOutput $guguTransactionOutput
    ${If} $guguTransactionResult == "3"
      StrCpy $guguFailureWasLock "true"
    ${ElseIf} $guguTransactionResult == "4"
      StrCpy $guguFailureForeignTarget "true"
    ${EndIf}
    Call guguRollback
    Call guguShowFailure
    SetErrorLevel 2
    Abort "The installation could not be completed. See the installer log."
  ${EndIf}
!macroend

# Called by the pinned app-builder-lib patch instead of uninstall/copy. The old
# uninstaller is deliberately not run: the complete old tree is renamed intact,
# registration is replaced by the stock macros, and user data is never touched.
!macro customInstallApplication
  !ifndef ZIP_COMPRESSION
    !error "Gugu's transactional installer requires useZip:true and differentialPackage:false"
  !endif
  StrCpy $guguDiagnosticDir "$TEMP\gugu-installer"
  StrCpy $guguFailureWasLock "false"
  StrCpy $guguFailureForeignTarget "false"
  StrCpy $guguFailureOutput ""
  StrCpy $guguFailureShown "false"
  Push "version=${VERSION} normalize target=$INSTDIR"
  Call guguWriteLog
  ${If} $guguLogReady != "true"
    DetailPrint "The installer diagnostic log is unavailable; continuing installation."
  ${EndIf}
  # Keep NSIS's staging path identical to the helper's canonical target. A /D
  # value ending in a slash must not turn the sibling journal into a child of
  # the old application. Preserve drive roots for the helper's explicit refusal.
  # Normalize lexically: NSIS GetFullPathName also asks for the long path and
  # clears its output when the chosen installation directory does not exist.
  # A fresh install must accept an absent destination, without creating it yet.
  ${If} $INSTDIR == ""
    Call guguShowFailure
    SetErrorLevel 2
    Abort "The installation directory is empty. Choose a valid directory."
  ${EndIf}
  Push $0
  Push $1
  System::Call 'kernel32::GetFullPathNameW(w "$INSTDIR", i ${NSIS_MAX_STRLEN}, w .r0, p 0) i.r1'
  ${If} $1 == 0
  ${OrIf} $1 >= ${NSIS_MAX_STRLEN}
    Pop $1
    Pop $0
    Call guguShowFailure
    SetErrorLevel 2
    Abort "The installation directory could not be normalized. Choose a valid directory."
  ${EndIf}
  StrCpy $INSTDIR $0
  Pop $1
  Pop $0
  ${Do}
    StrLen $R9 $INSTDIR
    ${If} $R9 <= 3
      ${Break}
    ${EndIf}
    StrCpy $R9 $INSTDIR 1 -1
    ${If} $R9 != "\"
      ${Break}
    ${EndIf}
    StrCpy $INSTDIR $INSTDIR -1
  ${Loop}
  StrCpy $guguPowerShell "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${IfNot} ${FileExists} "$guguPowerShell"
    StrCpy $guguPowerShell "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
  # .onInit selected INSTDIR as NSIS's current directory. Release that handle
  # before prepare removes an empty target or recovers a previous transaction.
  SetOutPath "$PLUGINSDIR"
  # ...and the same for the waiting non-elevated installer under UAC (see @@@uac-outer-cwd).
  ${If} ${UAC_IsInnerInstance}
    !insertmacro UAC_AsUser_Call Function guguLeaveInstallDirectory 0
  ${EndIf}
  File /oname=$PLUGINSDIR\install-transaction.ps1 "${BUILD_RESOURCES_DIR}\nsis\install-transaction.ps1"
  File /oname=$PLUGINSDIR\invoke-transaction.ps1 "${BUILD_RESOURCES_DIR}\nsis\invoke-transaction.ps1"
  FileOpen $R9 "$PLUGINSDIR\transaction-request.ini" w
  FileWriteWord $R9 0xFEFF
  FileClose $R9
  WriteINIStr "$PLUGINSDIR\transaction-request.ini" "transaction" "Target" "$INSTDIR"
  WriteINIStr "$PLUGINSDIR\transaction-request.ini" "transaction" "AppId" "${APP_ID}"
  WriteINIStr "$PLUGINSDIR\transaction-request.ini" "transaction" "Executable" "${APP_EXECUTABLE_FILENAME}"
  WriteINIStr "$PLUGINSDIR\transaction-request.ini" "transaction" "Version" "${VERSION}"
  WriteINIStr "$PLUGINSDIR\transaction-request.ini" "transaction" "InstallKey" "${INSTALL_REGISTRY_KEY}"
  WriteINIStr "$PLUGINSDIR\transaction-request.ini" "transaction" "UninstallKey" "${UNINSTALL_REGISTRY_KEY}"
  WriteINIStr "$PLUGINSDIR\transaction-request.ini" "transaction" "Mode" "$installMode"
  WriteINIStr "$PLUGINSDIR\transaction-request.ini" "transaction" "LinkManifest" "$PLUGINSDIR\installer-links.ini"
  System::Call 'kernel32::SetEnvironmentVariableW(w "GUGU_INSTALLER_ENTRY", w "$PLUGINSDIR\invoke-transaction.ps1") i .r9'
  ${If} $9 == 0
    Call guguShowFailure
    Abort "The installer could not configure its transaction entry."
  ${EndIf}
  System::Call 'kernel32::SetEnvironmentVariableW(w "GUGU_INSTALLER_HELPER", w "$PLUGINSDIR\install-transaction.ps1") i .r9'
  ${If} $9 == 0
    Call guguShowFailure
    Abort "The installer could not configure its transaction helper."
  ${EndIf}
  System::Call 'kernel32::SetEnvironmentVariableW(w "GUGU_INSTALLER_REQUEST", w "$PLUGINSDIR\transaction-request.ini") i .r9'
  ${If} $9 == 0
    Call guguShowFailure
    Abort "The installer could not configure its transaction request."
  ${EndIf}
  # Write a Unicode INI so names and paths never pass through a shell/code page.
  FileOpen $R9 "$PLUGINSDIR\installer-links.ini" w
  FileWriteWord $R9 0xFEFF
  FileClose $R9
  WriteINIStr "$PLUGINSDIR\installer-links.ini" "links" "newStart" "$newStartMenuLink"
  WriteINIStr "$PLUGINSDIR\installer-links.ini" "links" "oldStart" "$oldStartMenuLink"
  WriteINIStr "$PLUGINSDIR\installer-links.ini" "links" "newDesktop" "$newDesktopLink"
  WriteINIStr "$PLUGINSDIR\installer-links.ini" "links" "oldDesktop" "$oldDesktopLink"
  StrCpy $guguStage "$INSTDIR.gugu-install-${APP_ID}\stage"
  !insertmacro guguTransaction prepare
  !insertmacro guguRequireTransactionSuccess
  StrCpy $guguTransactionActive "true"

  # Decompress once on the destination volume. Publishing uses directory rename,
  # never the old 7z-out -> CopyFiles traversal (and never cross-volume MoveFile).
  !ifdef COMPRESS
    SetCompress off
  !endif
  Var /GLOBAL packageArch
  !insertmacro identify_package
  !insertmacro compute_files_for_current_arch
  !ifdef COMPRESS
    SetCompress "${COMPRESS}"
  !endif
  nsisunz::Unzip "$PLUGINSDIR\app-$packageArch.zip" "$guguStage"
  Pop $guguTransactionResult
  ${If} $guguTransactionResult != "success"
    StrCpy $guguFailureOutput "ZIP extraction failed: $guguTransactionResult"
    Push "$guguFailureOutput"
    Call guguWriteLog
    DetailPrint "ZIP extraction failed: $guguTransactionResult"
    Call guguRollback
    Call guguShowFailure
    SetErrorLevel 2
    Abort "Unable to extract the application. The previous installation has been preserved."
  ${EndIf}
  SetOutPath "$guguStage"
  File "/oname=${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"
  !ifdef UNINSTALLER_ICON
    File /oname=uninstallerIcon.ico "${UNINSTALLER_ICON}"
  !endif
  # Release NSIS's current-directory handle before renaming the staged tree.
  SetOutPath "$PLUGINSDIR"
  !insertmacro guguTransaction commit
  !insertmacro guguRequireTransactionSuccess
  SetOutPath "$INSTDIR" # stock CreateShortCut takes its working directory from OUTDIR
  !insertmacro custom_files_post_decompression
  # Full downloads do not need an old installer/blockmap in the updater cache.
!macroend

!macro customInstallApplicationComplete
  SetOutPath "$PLUGINSDIR" # release the published directory before failure recovery
  !insertmacro guguTransaction finish
  !insertmacro guguRequireTransactionSuccess
  StrCpy $guguTransactionActive "false"
  SetOutPath "$INSTDIR"
!macroend
!endif
