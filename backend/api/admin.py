from django.contrib import admin
from .models import StartingCapital, Customer, Material, Expense, Transaction
# Register your models here.
admin.site.register(StartingCapital)
admin.site.register(Customer)
admin.site.register(Material)
admin.site.register(Expense)
admin.site.register(Transaction)
