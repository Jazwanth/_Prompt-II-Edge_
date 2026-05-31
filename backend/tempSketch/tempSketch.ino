#include <ArduinoOTA.h>
#include <WiFi.h>

const char* ssid = "Galaxy";
const char* password = "password";

unsigned long lastMetricAt = 0;
float tempValue = 24.0;
float humidityValue = 52.0;
bool relayState = false;

void setup() {
  Serial.begin(115200);
  delay(250);

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);

  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());

  ArduinoOTA.setHostname("esp32-web-ide");
  ArduinoOTA.begin();

  Serial.println("OTA Ready");
}

void loop() {
  ArduinoOTA.handle();

  if (millis() - lastMetricAt >= 1000) {
    lastMetricAt = millis();
    tempValue += 0.35;
    humidityValue += relayState ? -0.4 : 0.25;
    relayState = !relayState;

    if (tempValue > 32.0) {
      tempValue = 24.0;
    }

    if (humidityValue > 62.0) {
      humidityValue = 52.0;
    }

    Serial.print("temp:");
    Serial.print(tempValue, 2);
    Serial.print(",humidity:");
    Serial.print(humidityValue, 2);
    Serial.print(",relay:");
    Serial.println(relayState ? 1 : 0);
  }
}
