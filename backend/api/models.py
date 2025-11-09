from django.db import models
from django.contrib.auth.models import User
from django.utils import timezone
from decimal import Decimal
				 

# Create your models here.

class StartingCapital(models.Model):
    description = models.CharField(max_length=255, verbose_name="Description")
    amount = models.DecimalField(max_digits=10, decimal_places=2, verbose_name="Amount")
    date = models.DateField(default=timezone.now, verbose_name="Date")

    def __str__(self):
        return f"Recived: {self.description} on {self.date}"


class Material(models.Model):
    """Stores information about the raw materials being traded."""
    name = models.CharField(max_length=100, unique=True, verbose_name="Material Name")
    color = models.CharField(max_length=50, blank=True, null=True, verbose_name="Color/Description")

    def __str__(self):
        return self.name

class Customer(models.Model):
    """Stores information about the purchasing parties."""
    name = models.CharField(max_length=100, unique=True, verbose_name="Customer Name")

    def __str__(self):
        return self.name

class Expense(models.Model):
    description = models.CharField(max_length=255, verbose_name="Expense Description")
    amount = models.DecimalField(max_digits=10, decimal_places=2, verbose_name="Amount")
    # Date incurred (not auto_now_add, allows backdating)
    date = models.DateField(default=timezone.now, verbose_name="Expense Date")
    expense_type = models.CharField(max_length=10)

    def __str__(self):
        return f"OExpense: {self.description} on {self.date}"

class Transaction(models.Model):
    TRANSACTION_CHOICES = [
        ('CR', 'Credit / Purchase'),
        ('DB', 'Debit / Sale'),
        ('RC', 'Reconciliation / Customer Payment'),
    ]

    transaction_type = models.CharField(max_length=2, choices=TRANSACTION_CHOICES, verbose_name="Type")

    # Linked Data - Nullable based on type
    material = models.ForeignKey(Material, on_delete=models.SET_NULL, null=True, blank=True, verbose_name="Material")
    customer = models.ForeignKey(Customer, on_delete=models.SET_NULL, null=True, blank=True, verbose_name="Customer")

    # Financial Data
    quantity = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True, verbose_name="Quantity")
    total_price = models.DecimalField(max_digits=10, decimal_places=2, verbose_name="Total Value")
    money_received = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True, default=Decimal('0.00'), verbose_name="Amount Received")

    # Metadata
    description = models.CharField(max_length=255, blank=True, null=True, verbose_name="Notes")
    timestamp = models.DateTimeField(auto_now_add=True, verbose_name="Timestamp")

    def __str__(self):
        return f"{self.get_transaction_type_display()} on {self.timestamp.strftime('%Y-%m-%d')}"
