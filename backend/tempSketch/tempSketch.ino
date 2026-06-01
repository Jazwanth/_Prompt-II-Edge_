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
  Serial.println("OLED display test started!");

  // Initialize I2C bus with default pins (GPIO21 SDA, GPIO22 SCL)
  // Wire.begin() is called by display.begin() if not explicitly called before.
  // If you need custom pins, use Wire.begin(SDA_PIN, SCL_PIN);

  // SSD1306_SWITCHCAPVCC = generate display voltage from 3.3V internally
  if(!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) { // Address 0x3C for 128x64
    Serial.println(F("SSD1306 allocation failed"));
    for(;;); // Don't proceed, loop forever
  }

  Serial.println("OLED initialized successfully.");

  // Clear the buffer
  display.clearDisplay();

  // Set text size
  display.setTextSize(2); // Draw 2X-scale text

  // Set text color
  display.setTextColor(SSD1306_WHITE); // Draw white text

  // Set cursor position
  display.setCursor(0, 0); // Start at top-left corner

  // Print text to the display buffer
  display.println("HI");

  // Display the buffer content
  display.display();
  Serial.println("Displayed 'HI' on OLED.");
}

void loop() {
  // Nothing to do in the loop for this simple example
  // The message "HI" is displayed once in setup.
}
