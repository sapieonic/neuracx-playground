output "public_ip" {
  description = "Static IP. Point an A record for your domain here."
  value       = aws_eip.app.public_ip
}

output "ssh" {
  value = "ssh ec2-user@${aws_eip.app.public_ip}"
}

output "ui_url" {
  value = "https://${var.domain}/"
}

output "stream_url" {
  description = "WebSocket URL to register in NeuraCX (add ?token=... if STREAM_TOKEN is set in .env)."
  value       = "wss://${var.domain}/stream"
}
