
void setup() {
  Serial.begin(115200);
}

void loop() {
  int value = random(0, 50);
  Serial.println(value);
  delay(500);
}
