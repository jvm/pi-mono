{
  "targets": [
    {
      "target_name": "openat",
      "sources": ["native/addon.c"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"]
    }
  ]
}
