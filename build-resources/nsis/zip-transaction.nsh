!ifndef BUILD_UNINSTALLER
Var guguStage
Var guguPowerShell
Var guguTransactionActive
Var guguTransactionResult

!macro guguTransaction PHASE
  nsExec::ExecToLog '"$guguPowerShell" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\install-transaction.ps1" -Phase ${PHASE} -Target "$INSTDIR" -AppId "${APP_ID}" -Executable "${APP_EXECUTABLE_FILENAME}" -Version "${VERSION}" -InstallKey "${INSTALL_REGISTRY_KEY}" -UninstallKey "${UNINSTALL_REGISTRY_KEY}" -Mode "$installMode"'
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
  StrCpy $guguPowerShell "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${IfNot} ${FileExists} "$guguPowerShell"
    StrCpy $guguPowerShell "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
  File /oname=$PLUGINSDIR\install-transaction.ps1 "${BUILD_RESOURCES_DIR}/nsis/install-transaction.ps1"
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
  !insertmacro custom_files_post_decompression
  # Full downloads do not need an old installer/blockmap in the updater cache.
!macroend

!macro customInstallApplicationComplete
  !insertmacro guguTransaction finish
  !insertmacro guguRequireTransactionSuccess
  StrCpy $guguTransactionActive "false"
  SetOutPath "$INSTDIR"
!macroend
!endif
