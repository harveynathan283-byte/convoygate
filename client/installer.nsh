!include "LogicLib.nsh"

!macro customUnInstall
  ${IfNot} ${isUpdated}
    RMDir /r "$DOCUMENTS\American Truck Simulator\mod"
    RMDir /r "$DOCUMENTS\Euro Truck Simulator 2\mod"

    Delete "$PROGRAMFILES\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.dll"
    Delete "$PROGRAMFILES\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate_plugin.dll"
    Delete "$PROGRAMFILES\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.key"

    Delete "$PROGRAMFILES64\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.dll"
    Delete "$PROGRAMFILES64\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate_plugin.dll"
    Delete "$PROGRAMFILES64\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.key"

    Delete "D:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.dll"
    Delete "D:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate_plugin.dll"
    Delete "D:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.key"

    Delete "E:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.dll"
    Delete "E:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate_plugin.dll"
    Delete "E:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.key"

    RMDir /r "$APPDATA\convoygate-client"
    RMDir /r "$APPDATA\convoygate"
  ${EndIf}
!macroend