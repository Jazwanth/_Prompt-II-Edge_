#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// OLED dimensions
#define SCREEN_WIDTH 128 // OLED display width, in pixels
#define SCREEN_HEIGHT 64 // OLED display height, in pixels

// Declaration for an SSD1306 display connected to I2C (SDA, SCL pins)
// The ESP32 default I2C pins are SDA (GPIO21) and SCL (GPIO22)
#define OLED_RESET -1 // Reset pin # (or -1 if sharing Arduino reset pin)
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

void setup() {
  Serial.begin(115200);
  Serial.println("OLED display project started!");
  Serial.println("Enter a message in the Serial Monitor to display it on the OLED.");

  // SSD1306_SWITCHCAPVCC = generate display voltage from 3.3V internally
  if(!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) { // Address 0x3C for 128x64
    Serial.println(F("SSD1306 allocation failed"));
    for(;;); // Don't proceed, loop forever
  }

  Serial.println("OLED initialized successfully.");

  // Clear the buffer
  display.clearDisplay();

  // Set text size and color (can be changed later)
  display.setTextSize(1); // Default text size
  display.setTextColor(SSD1306_WHITE); // Draw white text

  // Initial message
  display.setCursor(0, 0);
  display.println("Hello!");
  display.println("Send text via");
  display.println("Serial Monitor");
  display.display();
}

void loop() {
  if (Serial.available()) {
    String message = Serial.readStringUntil('\n'); // Read until newline character
    message.trim(); // Remove any leading/trailing whitespace

    if (message.length() > 0) {
      Serial.print("Received message: ");
      Serial.println(message);

      display.clearDisplay(); // Clear the display buffer
      display.setCursor(0, 0); // Set cursor to top-left

      // Adjust text size based on message length for better fit
      if (message.length() > 20) {
        display.setTextSize(1);
      } else if (message.length() > 10) {
        display.setTextSize(2);
      } else {
        display.setTextSize(3);
      }
      
      display.println(message); // Print the new message
      display.display(); // Show the buffer content on the OLED
      Serial.println("Message displayed on OLED.");
    } else {
      Serial.println("Empty message received, not updating OLED.");
    }
  }
  delay(100); // Small delay to prevent busy-waiting
}
