!ifndef BUILD_UNINSTALLER
Var guguStage
Var guguPowerShell
Var guguTransactionActive
Var guguTransactionResult

!macro guguTransaction PHASE
  nsExec::ExecToLog '"$guguPowerShell" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\install-transaction.ps1" -Phase ${PHASE} -Target "$INSTDIR" -AppId "${APP_ID}" -Executable "${APP_EXECUTABLE_FILENAME}" -Version "${VERSION}" -InstallKey "${INSTALL_REGISTRY_KEY}" -UninstallKey "${UNINSTALL_REGISTRY_KEY}" -Mode "$installMode" -LinkManifest "$PLUGINSDIR\installer-links.ini"'
  Pop $guguTransactionResult
!macroend

!macro customHeader
Function guguRollback
  ${If} $guguTransactionActive == "true"
    SetOutPath "$PLUGINSDIR"
    !insertmacro guguTransaction rollback
    StrCpy $guguTransactionActive "false"
  ${EndIf}
FunctionEnd

Function .onInstFailed
  Call guguRollback
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
    Call guguRollback
    SetErrorLevel 2
    Abort "The installation could not be completed. The previous installation has been preserved; see details."
  ${EndIf}
!macroend

# Called by the pinned app-builder-lib patch instead of uninstall/copy. The old
# uninstaller is deliberately not run: the complete old tree is renamed intact,
# registration is replaced by the stock macros, and user data is never touched.
!macro customInstallApplication
  !ifndef ZIP_COMPRESSION
    !error "Gugu's transactional installer requires useZip:true and differentialPackage:false"
  !endif
  # Keep NSIS's staging path identical to the helper's canonical target. A /D
  # value ending in a slash must not turn the sibling journal into a child of
  # the old application. Preserve drive roots for the helper's explicit refusal.
  GetFullPathName $INSTDIR "$INSTDIR"
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
    DetailPrint "ZIP extraction failed: $guguTransactionResult"
    Call guguRollback
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
