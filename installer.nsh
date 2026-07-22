!macro customInstall
  ; Migrate the incorrect per-user plugin location used by 0.1.x/early 0.2.0 builds.
  RMDir /r "$APPDATA\obs-studio\plugins\obs-stream-manager-output"
  FileOpen $0 "$INSTDIR\resources\installed-by-nsis" w
  FileWrite $0 "installed"
  FileClose $0
  WriteRegStr HKCU "Software\OBS Stream Manager" "ExecutablePath" "$INSTDIR\OBS Stream Manager.exe"

  ; An upgrade runs the previous uninstaller first, which removes its OBS plugin.
  ; Restore the bundled plugin here so OBS can launch the companion before the
  ; user has manually opened the newly installed application.
  ReadEnvStr $1 "ProgramData"
  StrCmp $1 "" obsPluginInstallDone
  CreateDirectory "$1\obs-studio\plugins\obs-stream-manager-output\bin\64bit"
  CreateDirectory "$1\obs-studio\plugins\obs-stream-manager-output\data\locale"
  CopyFiles /SILENT "$INSTDIR\resources\obs-plugin\bin\64bit\obs-stream-manager-output.dll" "$1\obs-studio\plugins\obs-stream-manager-output\bin\64bit\obs-stream-manager-output.dll"
  CopyFiles /SILENT "$INSTDIR\resources\obs-plugin\data\locale\en-US.ini" "$1\obs-studio\plugins\obs-stream-manager-output\data\locale\en-US.ini"
  obsPluginInstallDone:
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'schtasks.exe /Delete /F /TN "OBS Stream Manager"'
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "io.github.akina910.obs-stream-manager"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OBS Stream Manager"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "obs-stream-manager"
  DeleteRegKey HKCU "Software\OBS Stream Manager"
  RMDir /r "$APPDATA\obs-studio\plugins\obs-stream-manager-output"
  ReadEnvStr $1 "ProgramData"
  StrCmp $1 "" +2
  RMDir /r "$1\obs-studio\plugins\obs-stream-manager-output"
!macroend
