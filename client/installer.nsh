!include "LogicLib.nsh"

!macro customInstall
  ${If} ${FileExists} "$INSTDIR\convoygate_plugin.dll"
    ; Standard Steam (C: Drive)
    ${If} ${FileExists} "$PROGRAMFILES\Steam\steamapps\common\American Truck Simulator\bin\win_x64"
      CreateDirectory "$PROGRAMFILES\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins"
      CopyFiles /SILENT "$INSTDIR\convoygate_plugin.dll" "$PROGRAMFILES\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate_plugin.dll"
    ${EndIf}

    ${If} ${FileExists} "$PROGRAMFILES64\Steam\steamapps\common\American Truck Simulator\bin\win_x64"
      CreateDirectory "$PROGRAMFILES64\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins"
      CopyFiles /SILENT "$INSTDIR\convoygate_plugin.dll" "$PROGRAMFILES64\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate_plugin.dll"
    ${EndIf}

    ; Secondary Steam Drives (D: & E:)
    ${If}${FileExists} "D:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64"
      CreateDirectory "D:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins"
      CopyFiles /SILENT "$INSTDIR\convoygate_plugin.dll" "D:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate_plugin.dll"
    ${EndIf}

    ${If}${FileExists} "E:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64"
      CreateDirectory "E:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins"
      CopyFiles /SILENT "$INSTDIR\convoygate_plugin.dll" "E:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate_plugin.dll"
    ${EndIf}${EndIf}
!macroend

!macro customUnInstall
  RMDir /r "$DOCUMENTS\American Truck Simulator\mod"
  RMDir /r "$DOCUMENTS\Euro Truck Simulator 2\mod"

  Delete "$PROGRAMFILES\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate_plugin.dll"
  Delete "$PROGRAMFILES\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.key"
  Delete "$PROGRAMFILES64\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate_plugin.dll"
  Delete "$PROGRAMFILES64\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.key"
  Delete "D:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate_plugin.dll"
  Delete "D:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.key"
  Delete "E:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate_plugin.dll"
  Delete "E:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.key"

  RMDir /r "$APPDATA\convoygate-client"
  RMDir /r "$APPDATA\convoygate"
!macroend