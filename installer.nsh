!macro customInstall
  ; Migrate the obsolete v1 per-user plugin location.
  RMDir /r "$APPDATA\obs-studio\plugins\obs-stream-manager-output"
  FileOpen $0 "$INSTDIR\resources\installed-by-nsis" w
  FileWrite $0 "installed"
  FileClose $0
  WriteRegStr HKCU "Software\OBS Stream Manager" "ExecutablePath" "$INSTDIR\OBS Stream Manager.exe"

  ; Install v2 into OBS's per-user plugin directory. This is writable without
  ; administrator approval and avoids locked legacy DLLs in ProgramData.
  CreateDirectory "$APPDATA\obs-studio\plugins\obs-stream-manager-output-v2\bin\64bit"
  CreateDirectory "$APPDATA\obs-studio\plugins\obs-stream-manager-output-v2\data\locale"
  CreateDirectory "$APPDATA\obs-studio\plugins\obs-stream-manager-output-v2\data\obs-stream-manager-output-v2\locale"
  CopyFiles /SILENT "$INSTDIR\resources\obs-plugin\bin\64bit\obs-stream-manager-output-v2.dll" "$APPDATA\obs-studio\plugins\obs-stream-manager-output-v2\bin\64bit\obs-stream-manager-output-v2.dll"
  CopyFiles /SILENT "$INSTDIR\resources\obs-plugin\data\locale\en-US.ini" "$APPDATA\obs-studio\plugins\obs-stream-manager-output-v2\data\locale\en-US.ini"
  CopyFiles /SILENT "$INSTDIR\resources\obs-plugin\data\locale\en-US.ini" "$APPDATA\obs-studio\plugins\obs-stream-manager-output-v2\data\obs-stream-manager-output-v2\locale\en-US.ini"
  WriteRegStr HKCU "Environment" "OBS_PLUGINS_PATH" "$APPDATA\obs-studio\plugins\obs-stream-manager-output-v2\bin\64bit"
  WriteRegStr HKCU "Environment" "OBS_PLUGINS_DATA_PATH" "$APPDATA\obs-studio\plugins\obs-stream-manager-output-v2\data"
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'schtasks.exe /Delete /F /TN "OBS Stream Manager"'
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "io.github.akina910.obs-stream-manager"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OBS Stream Manager"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "obs-stream-manager"
  DeleteRegKey HKCU "Software\OBS Stream Manager"
  ReadRegStr $0 HKCU "Environment" "OBS_PLUGINS_PATH"
  StrCmp $0 "$APPDATA\obs-studio\plugins\obs-stream-manager-output-v2\bin\64bit" 0 +2
  DeleteRegValue HKCU "Environment" "OBS_PLUGINS_PATH"
  ReadRegStr $0 HKCU "Environment" "OBS_PLUGINS_DATA_PATH"
  StrCmp $0 "$APPDATA\obs-studio\plugins\obs-stream-manager-output-v2\data" 0 +2
  DeleteRegValue HKCU "Environment" "OBS_PLUGINS_DATA_PATH"
  RMDir /r "$APPDATA\obs-studio\plugins\obs-stream-manager-output"
  RMDir /r "$APPDATA\obs-studio\plugins\obs-stream-manager-output-v2"
!macroend
