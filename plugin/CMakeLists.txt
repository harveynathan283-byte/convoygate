cmake_minimum_required(VERSION 3.20)
project(convoygate_plugin C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Configure as 64-bit Windows DLL
add_library(convoygate SHARED
    convoygate_plugin.cpp
)

target_compile_definitions(convoygate PRIVATE
    WIN32_LEAN_AND_MEAN
    _CRT_SECURE_NO_WARNINGS
)

# Link Windows Cryptography API (Bcrypt) for hardware-accelerated signature checks
target_link_libraries(convoygate PRIVATE
    bcrypt
    advapi32
    user32
)

set_target_properties(convoygate PROPERTIES
    PREFIX ""
    OUTPUT_NAME "convoygate"
    SUFFIX ".dll"
)