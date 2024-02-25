# Homebridge Jacuzzi Prolink (encrypted panel) Spa Plugin
This plugin should work great if you have a Jacuzzi J-245 from early 2020's with an encrypted control panel.  Unfortuantely I realize that is a very small subet of users.  My hope is that one day I (or someone else) will have time to use this as a basepoint and expand for others.

The biggest known issue that prevent this plugin from being useful to more people are that:
1. This only works for encrypted panels.  My Jacuzzi was delivered summer 2021, it seems that any earlier may have an unencrypted panel.
2. Unlike the Balboa plugin, some pump settings are hard coded (mainly number and speeds). (As of initial commit, tweak spaClients.ts line 152 and 153.)

## Thanks
There are two projects that this would not have been possible without.
1. [pyjacuzzi by dhmsjs](https://github.com/dhmsjs/pyjacuzzi "pyjacuzzi by dhmsjs").  This would not have happened without David's assistance.  He did all of the leg work on the encrypted panel, and was incredibly helpful through email when troubleshooting an issue with the lights.
2. [homebridge-plugin-bwaspa by vincedarley](https://github.com/vincedarley/homebridge-plugin-bwaspa "homebridge-plugin-bwaspa by vincedarley") I started with a fork of this plugin and slowely pulled integrated pyjacuzzi into it.  95% of the Homebridge integration remains untouched from the original project.