#include <WiFi.h>

void setup() {
  Serial.begin(115200);
  while (!Serial) {
    ;
  }
  Serial.println("\nWiFi Scan Started");

  // WiFi.mode(WIFI_STA) ensures the ESP32 is in station mode,
  // which is necessary for scanning networks.
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(); // Disconnect from any previous connection
  delay(100);

  int n = WiFi.scanNetworks();
  Serial.println("WiFi Scan Done");
  if (n == 0) {
    Serial.println("No networks found");
  } else {
    Serial.print(n);
    Serial.println(" networks found");
    for (int i = 0; i < n; ++i) {
      // Print SSID and RSSI for each network found
      Serial.print(i + 1);
      Serial.print(": ");
      Serial.print(WiFi.SSID(i));
      Serial.print(" (");
      Serial.print(WiFi.RSSI(i));
      Serial.print(" dBm) ");
      Serial.print("Channel: ");
      Serial.print(WiFi.channel(i));
      Serial.print(" Enc: ");
      switch (WiFi.encryptionType(i)) {
        case WIFI_AUTH_OPEN:
          Serial.println("Open");
          break;
        case WIFI_AUTH_WEP:
          Serial.println("WEP");
          break;
        case WIFI_AUTH_WPA_PSK:
          Serial.println("WPA_PSK");
          break;
        case WIFI_AUTH_WPA2_PSK:
          Serial.println("WPA2_PSK");
          break;
        case WIFI_AUTH_WPA_WPA2_PSK:
          Serial.println("WPA_WPA2_PSK");
          break;
        case WIFI_AUTH_WPA2_ENTERPRISE:
          Serial.println("WPA2_ENTERPRISE");
          break;
        case WIFI_AUTH_MAX:
          Serial.println("MAX");
          break;
        default:
          Serial.println("Unknown");
          break;
      }
      delay(10);
    }
  }
  Serial.println("");
  // The scan is a one-time operation in setup for this example.
  // To repeat, move WiFi.scanNetworks() and printing to loop() 
  // with a delay.
}

void loop() {
  // Nothing to do in loop for a simple one-time scan example.
  // The ESP32 will continue to run, but no new scans will be performed.
  delay(1000);
}