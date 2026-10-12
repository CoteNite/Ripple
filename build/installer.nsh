!include nsDialogs.nsh
!include FileFunc.nsh
!ifndef BUILD_UNINSTALLER
!include getProcessInfo.nsh
Var pid
!macroundef _isForAllUsers
!macro _isForAllUsers _a _b _t _f
  Goto `${_f}`
!macroend
!macroundef _isDeleteAppData
!macro _isDeleteAppData _a _b _t _f
  Goto `${_f}`
!macroend
!endif
!undef APP_FILENAME
!define APP_FILENAME "ripple"

!ifndef BUILD_UNINSTALLER
Var RippleDirectoryField
Var RippleOriginalDirectory
Var RippleUpgradeTransaction
!endif
!ifdef BUILD_UNINSTALLER
Var RippleDeleteData
!endif

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
  StrCpy $isForceMachineInstall "0"
!macroend

!macro customInit
  StrCpy $hasPerMachineInstallation "0"
  StrCpy $hasPerUserInstallation "1"
  !insertmacro setInstallModePerUser
  ReadRegStr $RippleOriginalDirectory HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $RippleOriginalDirectory == ""
    ReadRegStr $RippleOriginalDirectory HKCU "Software\Ripple\UpgradeRecovery" InstallationDirectory
  ${EndIf}
  ${If} $RippleOriginalDirectory != ""
    StrCpy $INSTDIR $RippleOriginalDirectory
    Call RippleRecoverUpgrade
  ${EndIf}
  ${If} ${Silent}
    Call RippleValidateDirectory
  ${ElseIf} $RippleOriginalDirectory != ""
    Call RippleValidateDirectory
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom RippleDirectoryPage RippleDirectoryLeave
!macroend

!ifndef BUILD_UNINSTALLER
!macro customCheckAppRunning
  !insertmacro _CHECK_APP_RUNNING
  ${If} $RippleOriginalDirectory != ""
  ${AndIf} $RippleUpgradeTransaction == ""
    Call RippleProtectUpgrade
  ${EndIf}
!macroend
!endif
!macro customHeader
!ifndef BUILD_UNINSTALLER

Function RippleRecoverUpgrade
  StrCpy $RippleUpgradeTransaction "$INSTDIR.ripple-upgrade-transaction"
  IfFileExists "$RippleUpgradeTransaction\*.*" 0 recovered
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=ripple-upgrade.ps1 "${PROJECT_DIR}\scripts\windows-upgrade.ps1"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\ripple-upgrade.ps1" -Action Restore -InstallationDirectory "$INSTDIR" -TransactionDirectory "$RippleUpgradeTransaction"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Ripple 升级恢复失败，保护副本已保留。$\r$\n$1" /SD IDOK
    Abort
  ${EndIf}
  recovered:
  StrCpy $RippleUpgradeTransaction ""
FunctionEnd

Function RippleProtectUpgrade
  ${If} $RippleOriginalDirectory != ""
    StrCpy $INSTDIR $RippleOriginalDirectory
    Call RippleRecoverUpgrade
    Call RippleValidateDirectory
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File /oname=ripple-upgrade.ps1 "${PROJECT_DIR}\scripts\windows-upgrade.ps1"
    File /oname=ripple-legacy-program.json "${PROJECT_DIR}\build\legacy-program-files-0.1.7.json"
    StrCpy $RippleUpgradeTransaction "$INSTDIR.ripple-upgrade-transaction"
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\ripple-upgrade.ps1" -Action Protect -InstallationDirectory "$INSTDIR" -TransactionDirectory "$RippleUpgradeTransaction" -LegacyManifest "$PLUGINSDIR\ripple-legacy-program.json"'
    Pop $0
    Pop $1
    ${If} $0 != 0
      MessageBox MB_ICONSTOP "Ripple 升级保护失败，原数据未交给旧卸载器清理。$\r$\n$1" /SD IDOK
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

Function RippleDirectoryPage
  ${If} $RippleOriginalDirectory != ""
    StrCpy $INSTDIR $RippleOriginalDirectory
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Ripple 安装目录" "程序与用户数据将保存在此目录中。"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 30u "请选择当前用户可读写、本机固定磁盘上的 Ripple 专用目录。"
  Pop $0
  ${NSD_CreateDirRequest} 0 40u 100% 14u "$INSTDIR"
  Pop $RippleDirectoryField
  nsDialogs::Show
FunctionEnd

Function RippleDirectoryLeave
  ${NSD_GetText} $RippleDirectoryField $INSTDIR
  Call RippleValidateDirectory
FunctionEnd

Function RippleValidateDirectory
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=ripple-directory.ps1 "${PROJECT_DIR}\scripts\windows-directory.ps1"
  File /oname=ripple-incoming-files.json "${PROJECT_DIR}\release\win-unpacked\ripple-program-files.json"
  File /oname=ripple-legacy-files.json "${PROJECT_DIR}\build\legacy-program-files-0.1.7.json"
  StrCpy $2 ""
  ${If} $RippleOriginalDirectory != ""
    StrCpy $2 '-RegisteredDirectory "$RippleOriginalDirectory"'
  ${EndIf}
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\ripple-directory.ps1" -InstallationDirectory "$INSTDIR" $2 -IncomingManifest "$PLUGINSDIR\ripple-incoming-files.json" -LegacyManifest "$PLUGINSDIR\ripple-legacy-files.json"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "$1" /SD IDOK
    Abort
  ${EndIf}
FunctionEnd
!endif
!macroend

!macro customUnInit
  StrCpy $RippleDeleteData "0"
  ${IfNot} ${Silent}
  ${AndIfNot} ${isUpdated}
    MessageBox MB_YESNO|MB_DEFBUTTON2|MB_ICONQUESTION "是否同时删除 Ripple 用户数据和迁移备份？$\r$\n选择否（默认）将保留内容，独立导出文件始终保留。" IDNO RippleKeepData
    StrCpy $RippleDeleteData "1"
    RippleKeepData:
  ${EndIf}
!macroend

!macro customRemoveFiles
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  ${If} $RippleDeleteData == "1"
  ${AndIfNot} ${Silent}
  ${AndIfNot} ${isUpdated}
    nsExec::ExecToStack '"$INSTDIR\resources\backend\RSSReaderBackend\RSSReaderBackend.exe" --delete-installation-data "$INSTDIR"'
    Pop $0
    Pop $1
    ${If} $0 != 0
      MessageBox MB_ICONSTOP "Ripple 用户数据清理失败，卸载已停止。$\r$\n$1"
      Abort
    ${EndIf}
  ${EndIf}
  File /oname=ripple-lifecycle.ps1 "${PROJECT_DIR}\scripts\windows-lifecycle.ps1"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\ripple-lifecycle.ps1" -Action RemoveProgram -InstallationDirectory "$INSTDIR"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Ripple 程序清理失败。用户数据已保留。$\r$\n$1"
    Abort
  ${EndIf}
  ; Stock legacy-AppData cleanup must never consume a silent deletion flag.
  StrCpy $CMDLINE '"$EXEPATH" /KEEP_APP_DATA'
  RMDir "$INSTDIR"
!macroend

!macro customInstall
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  ${If} $RippleUpgradeTransaction != ""
    File /oname=ripple-upgrade.ps1 "${PROJECT_DIR}\scripts\windows-upgrade.ps1"
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\ripple-upgrade.ps1" -Action Restore -InstallationDirectory "$INSTDIR" -TransactionDirectory "$RippleUpgradeTransaction"'
    Pop $0
    Pop $1
    ${If} $0 != 0
      MessageBox MB_ICONSTOP "Ripple 升级内容恢复失败，保护副本仍在 $RippleUpgradeTransaction。$\r$\n$1" /SD IDOK
      Abort
    ${EndIf}
  ${EndIf}
  File /oname=ripple-register.ps1 "${PROJECT_DIR}\scripts\windows-lifecycle.ps1"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\ripple-register.ps1" -Action RegisterProgram -InstallationDirectory "$INSTDIR"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Ripple 程序文件登记失败。$\r$\n$1"
    Abort
  ${EndIf}
!macroend
